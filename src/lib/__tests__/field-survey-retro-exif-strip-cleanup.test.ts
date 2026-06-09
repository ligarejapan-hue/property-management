/**
 * 遡及 EXIF strip cleanup dry-run 列挙（retro-exif-strip-cleanup.ts）の単体テスト（PR-R2c-i）。
 *
 * 方針:
 *   - prisma / storage 実体 / process / node:fs を一切使わない。合成 run-log 行 + fake lookupRow のみ。
 *   - R2c-i は dry-run 列挙のみ。storage.delete 導線は存在しない（--delete / --confirm は PR-R2c-ii）。
 *   - 削除対象の権威ソース = apply の JSONL run-log。outcome==="repointed" 行の
 *     oldKey / 非 null oldThumbnailKey のみを候補化する。
 *   - 削除前の安全確認 = 現 DB 行（lookupRow）の fileUrl / thumbnailUrl が候補 key を
 *     まだ参照していないか。参照中 / 抽出不能 / 行消滅 / 非 canonical は理由付き skip（fail-closed）。
 *   - summary は per-line streaming fold（結果配列を保持しない）。出力は非 PII。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  parseCleanupRunLogLine,
  parseCleanupCliArgs,
  runCleanupDryRun,
  cleanupDryRunExitCode,
  emptyCleanupSummary,
  isSameIoPath,
  runCleanupDelete,
  preValidateCleanupRunLog,
  cleanupDeleteExitCode,
  emptyCleanupDeleteSummary,
  CLEANUP_DRY_RUN_OUTCOMES,
  CLEANUP_DRY_RUN_EXIT_OK,
  CLEANUP_DRY_RUN_EXIT_MALFORMED,
  CLEANUP_DRY_RUN_EXIT_STILL_REFERENCED,
  CLEANUP_DELETE_OUTCOMES,
  CLEANUP_DELETE_EXIT_OK,
  CLEANUP_DELETE_EXIT_MALFORMED,
  CLEANUP_DELETE_EXIT_STILL_REFERENCED,
  CLEANUP_DELETE_EXIT_DELETE_FAILED,
  type CleanupDryRunLogLine,
  type CleanupDryRunPorts,
  type CleanupCurrentRow,
  type CleanupDeletePorts,
  type CleanupDeleteLogLine,
  type CleanupDeleteResult,
} from "@/lib/field-survey/retro-exif-strip-cleanup";
import { toRunLogLine } from "@/lib/field-survey/retro-exif-strip-cli";
import type { RetroStripRowResult } from "@/lib/field-survey/retro-exif-strip";

// ---------------------------------------------------------------
// fixture（既存 retro-exif テストと同方針の UUID / key 体系）
// ---------------------------------------------------------------

const PIN_ID = "11111111-1111-4111-8111-111111111111";
const PHOTO_ID = "22222222-2222-4222-8222-222222222222";
const UUID = "33333333-3333-4333-8333-333333333333";

const OLD_KEY = `field-survey/pins/${PIN_ID}/photos/old-photo.jpg`;
const OLD_THUMB_KEY = `field-survey/pins/${PIN_ID}/photos/old-thumb.jpg`;
const NEW_KEY = `field-survey/pins/${PIN_ID}/photos/${UUID}.jpg`;
const NEW_THUMB_KEY = `field-survey/pins/${PIN_ID}/photos/${UUID}-thumb.jpg`;

const uploads = (k: string) => `/uploads/${k}`;

/** apply run-log の repointed 行を模した JSONL 1 行。 */
function repointedLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    photoId: PHOTO_ID,
    outcome: "repointed",
    oldKey: OLD_KEY,
    newKey: NEW_KEY,
    bytesBefore: 1000,
    bytesAfter: 900,
    ...overrides,
  });
}

async function* linesOf(...lines: string[]): AsyncGenerator<string> {
  for (const l of lines) yield l;
}

function makeLookup(rows: Record<string, CleanupCurrentRow | null>) {
  const calls: string[] = [];
  const ports: CleanupDryRunPorts = {
    async lookupRow(photoId) {
      calls.push(photoId);
      return Object.prototype.hasOwnProperty.call(rows, photoId)
        ? rows[photoId]
        : null;
    },
  };
  return { ports, calls };
}

async function runCollect(
  lines: AsyncIterable<string>,
  ports: CleanupDryRunPorts,
) {
  const out: CleanupDryRunLogLine[] = [];
  const result = await runCleanupDryRun(lines, ports, (line) => {
    out.push(line);
  });
  return { result, out };
}

/** 指定 kind の出力行を取り出す。 */
function pick(
  out: CleanupDryRunLogLine[],
  kind: "file" | "thumbnail",
): CleanupDryRunLogLine | undefined {
  return out.find((l) => l.kind === kind);
}

// ---------------------------------------------------------------
// parseCleanupRunLogLine（純関数・DB なし）
// ---------------------------------------------------------------

describe("parseCleanupRunLogLine", () => {
  it("空行 / 空白のみは blank（候補化も集計もしない）", () => {
    expect(parseCleanupRunLogLine("", 1).kind).toBe("blank");
    expect(parseCleanupRunLogLine("   ", 2).kind).toBe("blank");
  });

  it("不正 JSON は malformed（fail-closed）", () => {
    const r = parseCleanupRunLogLine("{not json", 5);
    expect(r.kind).toBe("malformed");
    if (r.kind === "malformed") expect(r.lineNumber).toBe(5);
  });

  it("非オブジェクト（配列 / 数値 / null）は malformed", () => {
    expect(parseCleanupRunLogLine("123", 1).kind).toBe("malformed");
    expect(parseCleanupRunLogLine("[]", 1).kind).toBe("malformed");
    expect(parseCleanupRunLogLine("null", 1).kind).toBe("malformed");
  });

  it("photoId 欠落は malformed", () => {
    expect(
      parseCleanupRunLogLine(JSON.stringify({ outcome: "repointed", oldKey: OLD_KEY }), 1).kind,
    ).toBe("malformed");
  });

  it("outcome 欠落は malformed", () => {
    expect(
      parseCleanupRunLogLine(JSON.stringify({ photoId: PHOTO_ID, oldKey: OLD_KEY }), 1).kind,
    ).toBe("malformed");
  });

  it("outcome !== repointed は not_repointed（sourceOutcome を保持・候補化しない）", () => {
    const r = parseCleanupRunLogLine(
      JSON.stringify({ photoId: PHOTO_ID, outcome: "skipped_row_changed", oldKey: OLD_KEY, newKey: NEW_KEY }),
      1,
    );
    expect(r.kind).toBe("not_repointed");
    if (r.kind === "not_repointed") {
      expect(r.photoId).toBe(PHOTO_ID);
      expect(r.sourceOutcome).toBe("skipped_row_changed");
    }
  });

  it("repointed + oldKey のみ（thumbnail 無し）→ file 候補 1 件", () => {
    const r = parseCleanupRunLogLine(repointedLine(), 1);
    expect(r.kind).toBe("candidates");
    if (r.kind === "candidates") {
      expect(r.photoId).toBe(PHOTO_ID);
      expect(r.candidates).toEqual([{ kind: "file", key: OLD_KEY }]);
    }
  });

  it("repointed + oldKey + oldThumbnailKey → file / thumbnail 2 候補", () => {
    const r = parseCleanupRunLogLine(repointedLine({ oldThumbnailKey: OLD_THUMB_KEY }), 1);
    expect(r.kind).toBe("candidates");
    if (r.kind === "candidates") {
      expect(r.candidates).toEqual([
        { kind: "file", key: OLD_KEY },
        { kind: "thumbnail", key: OLD_THUMB_KEY },
      ]);
    }
  });

  it("repointed なのに oldKey 欠落は malformed（fail-closed）", () => {
    const r = parseCleanupRunLogLine(
      JSON.stringify({ photoId: PHOTO_ID, outcome: "repointed", newKey: NEW_KEY }),
      9,
    );
    expect(r.kind).toBe("malformed");
  });

  it("oldThumbnailKey が空文字 / 非文字列は malformed（壊れ行を握りつぶさない）", () => {
    expect(parseCleanupRunLogLine(repointedLine({ oldThumbnailKey: "" }), 1).kind).toBe("malformed");
    expect(parseCleanupRunLogLine(repointedLine({ oldThumbnailKey: 123 }), 1).kind).toBe("malformed");
  });

  it("oldThumbnailKey が null（apply の null-omit 相当）→ thumbnail 候補なし・file 候補のみ", () => {
    // apply の toRunLogLine は oldThumbnailKey が null のとき field を省略するが、
    // 手書き / 将来形式で null が明示されても undefined と同様に扱い、file 候補は失わない。
    const r = parseCleanupRunLogLine(repointedLine({ oldThumbnailKey: null }), 1);
    expect(r.kind).toBe("candidates");
    if (r.kind === "candidates") {
      expect(r.candidates).toEqual([{ kind: "file", key: OLD_KEY }]);
    }
  });
});

// ---------------------------------------------------------------
// parseCleanupCliArgs（R2c-i は列挙のみ・delete 系フラグは拒否）
// ---------------------------------------------------------------

describe("parseCleanupCliArgs", () => {
  it("--apply-run-log <path> を受理する", () => {
    const r = parseCleanupCliArgs(["--apply-run-log", "/tmp/apply.jsonl"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.applyRunLogPath).toBe("/tmp/apply.jsonl");
      expect(r.options.outPath).toBeNull();
      expect(r.options.help).toBe(false);
    }
  });

  it("--out <path> を受理する", () => {
    const r = parseCleanupCliArgs(["--apply-run-log", "/tmp/a.jsonl", "--out", "/tmp/cleanup.jsonl"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.outPath).toBe("/tmp/cleanup.jsonl");
  });

  it("--apply-run-log 未指定はエラー（入力 run-log 必須）", () => {
    const r = parseCleanupCliArgs([]);
    expect(r.ok).toBe(false);
  });

  it("--help は mode 不要で受理", () => {
    const r = parseCleanupCliArgs(["--help"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.help).toBe(true);
  });

  it("フラグ無し（dry-run）は delete=false / confirm=false（R2c-i 後方互換）", () => {
    const r = parseCleanupCliArgs(["--apply-run-log", "/tmp/a.jsonl"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.delete).toBe(false);
      expect(r.options.confirm).toBe(false);
    }
  });

  it("--delete 単独は拒否（--confirm が必須＝二重ゲート）", () => {
    const r = parseCleanupCliArgs(["--apply-run-log", "/tmp/a.jsonl", "--delete", "--out", "/tmp/d.jsonl"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("--confirm");
  });

  it("--confirm 単独は拒否（--delete が必須＝二重ゲート）", () => {
    const r = parseCleanupCliArgs(["--apply-run-log", "/tmp/a.jsonl", "--confirm", "--out", "/tmp/d.jsonl"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("--delete");
  });

  it("--delete --confirm --out で実削除モードを受理（二重ゲート両方）", () => {
    const r = parseCleanupCliArgs([
      "--apply-run-log",
      "/tmp/a.jsonl",
      "--delete",
      "--confirm",
      "--out",
      "/tmp/del.jsonl",
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.delete).toBe(true);
      expect(r.options.confirm).toBe(true);
      expect(r.options.outPath).toBe("/tmp/del.jsonl");
    }
  });

  it("--delete --confirm で --out 未指定は拒否（不可逆ゆえ delete log 必須）", () => {
    const r = parseCleanupCliArgs(["--apply-run-log", "/tmp/a.jsonl", "--delete", "--confirm"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("--out");
  });

  it("未知オプションは拒否", () => {
    const r = parseCleanupCliArgs(["--apply-run-log", "/tmp/a.jsonl", "--bogus"]);
    expect(r.ok).toBe(false);
  });

  it("--apply-run-log に値が無い / 次がフラグはエラー", () => {
    expect(parseCleanupCliArgs(["--apply-run-log"]).ok).toBe(false);
    expect(parseCleanupCliArgs(["--apply-run-log", "--out"]).ok).toBe(false);
  });
});

// ---------------------------------------------------------------
// runCleanupDryRun（候補列挙 + DB 再確認 + streaming 集計）
// ---------------------------------------------------------------

describe("runCleanupDryRun", () => {
  it("repointed・thumbnail 無し・現 DB は new key → file のみ deletable（oldKey のみ候補化）", async () => {
    const { ports } = makeLookup({
      [PHOTO_ID]: { fileUrl: uploads(NEW_KEY), thumbnailUrl: null },
    });
    const { result, out } = await runCollect(linesOf(repointedLine()), ports);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ outcome: "deletable", kind: "file", candidateKey: OLD_KEY, photoId: PHOTO_ID });
    expect(result.summary.deletable).toBe(1);
  });

  it("repointed・file + thumbnail 両方が非参照 → 2 候補とも deletable", async () => {
    const { ports } = makeLookup({
      [PHOTO_ID]: { fileUrl: uploads(NEW_KEY), thumbnailUrl: uploads(NEW_THUMB_KEY) },
    });
    const { result, out } = await runCollect(
      linesOf(repointedLine({ oldThumbnailKey: OLD_THUMB_KEY })),
      ports,
    );
    expect(result.summary.deletable).toBe(2);
    expect(pick(out, "file")).toMatchObject({ outcome: "deletable", candidateKey: OLD_KEY });
    expect(pick(out, "thumbnail")).toMatchObject({ outcome: "deletable", candidateKey: OLD_THUMB_KEY });
  });

  it("file は現 DB 参照中・thumbnail は非参照 → file=skipped_still_referenced / thumbnail=deletable（独立評価）", async () => {
    const { ports } = makeLookup({
      [PHOTO_ID]: { fileUrl: uploads(OLD_KEY), thumbnailUrl: uploads(NEW_THUMB_KEY) },
    });
    const { result, out } = await runCollect(
      linesOf(repointedLine({ oldThumbnailKey: OLD_THUMB_KEY })),
      ports,
    );
    expect(pick(out, "file")).toMatchObject({
      outcome: "skipped_still_referenced",
      candidateKey: OLD_KEY,
      currentKey: OLD_KEY,
    });
    expect(pick(out, "thumbnail")).toMatchObject({ outcome: "deletable", candidateKey: OLD_THUMB_KEY });
    expect(result.summary.skipped_still_referenced).toBe(1);
    expect(result.summary.deletable).toBe(1);
  });

  it("現 DB fileUrl が抽出不能（unmappable URL）→ skipped_unmappable（fail-closed・非参照を証明できない）", async () => {
    const { ports } = makeLookup({
      [PHOTO_ID]: { fileUrl: "data:image/jpeg;base64,AAAA", thumbnailUrl: null },
    });
    const { result, out } = await runCollect(linesOf(repointedLine()), ports);
    expect(out[0]).toMatchObject({ outcome: "skipped_unmappable", kind: "file", candidateKey: OLD_KEY });
    expect(result.summary.skipped_unmappable).toBe(1);
  });

  it("現 thumbnailUrl が null（参照なし）→ 旧 thumbnail 候補は orphan として deletable・file 候補も deletable（null は unmappable ではない）", async () => {
    // P2-2: thumbnailUrl===null は「参照なし」として扱う。両カラム（fileUrl=newKey / thumbnail=null）の
    // どちらも旧 thumbnail key を参照しないため、旧 thumbnail は orphan = deletable。file 候補も妨げない。
    const { ports } = makeLookup({
      [PHOTO_ID]: { fileUrl: uploads(NEW_KEY), thumbnailUrl: null },
    });
    const { out } = await runCollect(
      linesOf(repointedLine({ oldThumbnailKey: OLD_THUMB_KEY })),
      ports,
    );
    expect(pick(out, "file")).toMatchObject({ outcome: "deletable", candidateKey: OLD_KEY });
    expect(pick(out, "thumbnail")).toMatchObject({ outcome: "deletable", candidateKey: OLD_THUMB_KEY });
  });

  // ---- P2-2: 候補 key を現 DB 行の両カラム（fileUrl / thumbnailUrl）に照合する ----

  it("[cross-column] old file key が現 thumbnailUrl に入っている → file 候補を skipped_still_referenced", async () => {
    const { ports } = makeLookup({
      [PHOTO_ID]: { fileUrl: uploads(NEW_KEY), thumbnailUrl: uploads(OLD_KEY) },
    });
    const { out } = await runCollect(linesOf(repointedLine()), ports);
    expect(out[0]).toMatchObject({
      outcome: "skipped_still_referenced",
      kind: "file",
      candidateKey: OLD_KEY,
      currentKey: OLD_KEY,
      referencedColumn: "thumbnail",
    });
  });

  it("[cross-column] old thumbnail key が現 fileUrl に入っている → thumbnail 候補を skipped_still_referenced", async () => {
    const { ports } = makeLookup({
      [PHOTO_ID]: { fileUrl: uploads(OLD_THUMB_KEY), thumbnailUrl: null },
    });
    const { out } = await runCollect(
      linesOf(repointedLine({ oldThumbnailKey: OLD_THUMB_KEY })),
      ports,
    );
    expect(pick(out, "thumbnail")).toMatchObject({
      outcome: "skipped_still_referenced",
      candidateKey: OLD_THUMB_KEY,
      currentKey: OLD_THUMB_KEY,
      referencedColumn: "file",
    });
  });

  it("[cross-column] 反対カラムが legacy absolute URL でも一致検出する", async () => {
    const { ports } = makeLookup({
      [PHOTO_ID]: {
        fileUrl: uploads(NEW_KEY),
        thumbnailUrl: `https://example.com${uploads(OLD_KEY)}`,
      },
    });
    const { out } = await runCollect(linesOf(repointedLine()), ports);
    expect(out[0]).toMatchObject({
      outcome: "skipped_still_referenced",
      kind: "file",
      candidateKey: OLD_KEY,
      referencedColumn: "thumbnail",
    });
  });

  it("[cross-column] non-null だが抽出不能なカラムがある → skipped_unmappable（fail-closed）", async () => {
    // file 候補 OLD_KEY は fileUrl=newKey で非参照だが、thumbnailUrl が non-null unmappable のため
    // 「thumbnailUrl が候補を参照しない」ことを証明できず fail-closed。
    const { ports } = makeLookup({
      [PHOTO_ID]: { fileUrl: uploads(NEW_KEY), thumbnailUrl: "data:image/jpeg;base64,AAAA" },
    });
    const { out } = await runCollect(linesOf(repointedLine()), ports);
    expect(out[0]).toMatchObject({ outcome: "skipped_unmappable", kind: "file", candidateKey: OLD_KEY });
  });

  it("[cross-column] thumbnailUrl === null は file 候補の deletable 判定を妨げない", async () => {
    const { ports } = makeLookup({
      [PHOTO_ID]: { fileUrl: uploads(NEW_KEY), thumbnailUrl: null },
    });
    const { out } = await runCollect(linesOf(repointedLine()), ports);
    expect(out[0]).toMatchObject({ outcome: "deletable", kind: "file", candidateKey: OLD_KEY });
  });

  it("photoId が現 DB に無い（行消滅）→ skipped_row_missing", async () => {
    const { ports } = makeLookup({}); // lookup は常に null
    const { result, out } = await runCollect(
      linesOf(repointedLine({ oldThumbnailKey: OLD_THUMB_KEY })),
      ports,
    );
    expect(out.every((l) => l.outcome === "skipped_row_missing")).toBe(true);
    expect(result.summary.skipped_row_missing).toBe(2);
  });

  it("候補 key が非 canonical（traversal 等）→ skipped_invalid_key（DB を見るまでもなく skip）", async () => {
    const { ports } = makeLookup({
      [PHOTO_ID]: { fileUrl: uploads(NEW_KEY), thumbnailUrl: null },
    });
    const { result, out } = await runCollect(
      linesOf(repointedLine({ oldKey: "../secret.jpg" })),
      ports,
    );
    expect(out[0]).toMatchObject({ outcome: "skipped_invalid_key", candidateKey: "../secret.jpg" });
    expect(result.summary.skipped_invalid_key).toBe(1);
  });

  it("候補 key に query/fragment（? / #）が含まれる → skipped_invalid_key（現 key と決して一致せず誤 deletable 化を防ぐ）", async () => {
    // isValidStorageKey は ? / # を弾かないが、現 DB 側の key 抽出は query/fragment を切り落とす。
    // ? / # 付き候補 key は現 key と決して一致せず still_referenced を deletable と誤判定し得るため、
    // cleanup 側で防御的に弾く（apply の canonical 検証で repointed の oldKey は ?/# を含まない）。
    const { ports } = makeLookup({
      [PHOTO_ID]: { fileUrl: uploads(NEW_KEY), thumbnailUrl: null },
    });
    const q = await runCollect(linesOf(repointedLine({ oldKey: `${OLD_KEY}?v=2` })), ports);
    expect(q.out[0]).toMatchObject({ outcome: "skipped_invalid_key", candidateKey: `${OLD_KEY}?v=2` });
    const h = await runCollect(linesOf(repointedLine({ oldKey: `${OLD_KEY}#frag` })), ports);
    expect(h.out[0]).toMatchObject({ outcome: "skipped_invalid_key", candidateKey: `${OLD_KEY}#frag` });
  });

  it("現 DB fileUrl に query（?v=2）が付いても query を切り落として still_referenced 判定", async () => {
    const { ports } = makeLookup({
      [PHOTO_ID]: { fileUrl: `${uploads(OLD_KEY)}?v=2`, thumbnailUrl: null },
    });
    const { out } = await runCollect(linesOf(repointedLine()), ports);
    expect(out[0]).toMatchObject({
      outcome: "skipped_still_referenced",
      candidateKey: OLD_KEY,
      currentKey: OLD_KEY,
    });
  });

  it("malformed JSONL 行は fail-closed skip（malformed_line・処理は継続）", async () => {
    const { ports } = makeLookup({
      [PHOTO_ID]: { fileUrl: uploads(NEW_KEY), thumbnailUrl: null },
    });
    const { result, out } = await runCollect(
      linesOf("{broken", repointedLine()),
      ports,
    );
    expect(result.summary.malformed_line).toBe(1);
    expect(result.summary.deletable).toBe(1);
    const bad = out.find((l) => l.outcome === "malformed_line");
    expect(bad).toMatchObject({ outcome: "malformed_line", lineNumber: 1 });
  });

  it("outcome !== repointed の行は skipped_not_repointed（lookupRow を呼ばない）", async () => {
    const { ports, calls } = makeLookup({
      [PHOTO_ID]: { fileUrl: uploads(NEW_KEY), thumbnailUrl: null },
    });
    const notRepointed = JSON.stringify({
      photoId: PHOTO_ID,
      outcome: "skipped_row_changed",
      oldKey: OLD_KEY,
      newKey: NEW_KEY,
      compensationDeleted: true,
    });
    const { result, out } = await runCollect(linesOf(notRepointed), ports);
    expect(out[0]).toMatchObject({ outcome: "skipped_not_repointed", sourceOutcome: "skipped_row_changed" });
    expect(result.summary.skipped_not_repointed).toBe(1);
    expect(calls).toHaveLength(0); // DB 再確認は repointed 行のみ
  });

  it("legacy absolute URL 由来の現 DB 再確認: https 絶対 URL から key を抽出して判定する", async () => {
    // 現 DB が legacy absolute（https://host/uploads/{newKey}）→ 抽出して new key → deletable。
    const deletable = makeLookup({
      [PHOTO_ID]: { fileUrl: `https://example.com${uploads(NEW_KEY)}`, thumbnailUrl: null },
    });
    const r1 = await runCollect(linesOf(repointedLine()), deletable.ports);
    expect(r1.out[0]).toMatchObject({ outcome: "deletable", candidateKey: OLD_KEY });

    // 現 DB が legacy absolute で旧 key を指す → still_referenced（誤削除しない）。
    const stillRef = makeLookup({
      [PHOTO_ID]: { fileUrl: `https://example.com${uploads(OLD_KEY)}`, thumbnailUrl: null },
    });
    const r2 = await runCollect(linesOf(repointedLine()), stillRef.ports);
    expect(r2.out[0]).toMatchObject({ outcome: "skipped_still_referenced", candidateKey: OLD_KEY });
  });

  it("lookupRow は repointed 行ごとに 1 回（候補数に依らない）", async () => {
    const { ports, calls } = makeLookup({
      [PHOTO_ID]: { fileUrl: uploads(NEW_KEY), thumbnailUrl: uploads(NEW_THUMB_KEY) },
    });
    await runCollect(linesOf(repointedLine({ oldThumbnailKey: OLD_THUMB_KEY })), ports);
    expect(calls).toEqual([PHOTO_ID]); // 2 候補でも lookup は 1 回
  });

  it("legacy absolute URL 由来の現 DB 再確認: thumbnail 側も https 絶対 URL から判定する", async () => {
    const { ports } = makeLookup({
      [PHOTO_ID]: {
        fileUrl: uploads(NEW_KEY),
        thumbnailUrl: `https://example.com${uploads(NEW_THUMB_KEY)}`,
      },
    });
    const { out } = await runCollect(
      linesOf(repointedLine({ oldThumbnailKey: OLD_THUMB_KEY })),
      ports,
    );
    expect(pick(out, "thumbnail")).toMatchObject({ outcome: "deletable", candidateKey: OLD_THUMB_KEY });
  });

  it("複数 photoId の repointed 行: lookupRow は行ごと・summary を正しく合算", async () => {
    const PHOTO_ID_2 = "44444444-4444-4444-8444-444444444444";
    const OLD_KEY_2 = `field-survey/pins/${PIN_ID}/photos/old-photo-2.jpg`;
    const { ports, calls } = makeLookup({
      [PHOTO_ID]: { fileUrl: uploads(NEW_KEY), thumbnailUrl: null }, // deletable
      [PHOTO_ID_2]: { fileUrl: uploads(OLD_KEY_2), thumbnailUrl: null }, // still referenced
    });
    const line2 = JSON.stringify({
      photoId: PHOTO_ID_2,
      outcome: "repointed",
      oldKey: OLD_KEY_2,
      newKey: NEW_KEY,
    });
    const { result } = await runCollect(linesOf(repointedLine(), line2), ports);
    expect(calls).toEqual([PHOTO_ID, PHOTO_ID_2]); // lookup は repointed 行ごとに 1 回
    expect(result.summary.deletable).toBe(1);
    expect(result.summary.skipped_still_referenced).toBe(1);
  });

  it("malformed の lineNumber は blank 行を含めた実ファイル行番号（locate 用）", async () => {
    const { ports } = makeLookup({});
    const { out } = await runCollect(linesOf("", "   ", "{broken"), ports);
    const bad = out.find((l) => l.outcome === "malformed_line");
    expect(bad).toMatchObject({ outcome: "malformed_line", lineNumber: 3 });
  });

  it("空行は無視し、複数行の混在を正しく集計する（streaming）", async () => {
    const { ports } = makeLookup({
      [PHOTO_ID]: { fileUrl: uploads(NEW_KEY), thumbnailUrl: null },
    });
    const { result } = await runCollect(
      linesOf(repointedLine(), "", "   ", "{broken"),
      ports,
    );
    expect(result.summary.deletable).toBe(1);
    expect(result.summary.malformed_line).toBe(1);
    expect(result.lines).toBe(2); // blank 2 行は lines に数えない
  });

  it("非 PII: 入力行の余分な PII フィールド（fileName / newFileUrl）を出力へ echo しない", async () => {
    const { ports } = makeLookup({
      [PHOTO_ID]: { fileUrl: uploads(NEW_KEY), thumbnailUrl: null },
    });
    const SENTINEL = "SENTINEL-PII-FILENAME.jpg";
    const line = repointedLine({
      oldThumbnailKey: OLD_THUMB_KEY,
      fileName: SENTINEL,
      newFileUrl: `/uploads/${SENTINEL}`,
    });
    const { out } = await runCollect(linesOf(line), ports);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("SENTINEL");
    expect(serialized).not.toContain("fileName");
    expect(serialized).not.toContain("newFileUrl");
    // 出力行は whitelist された key のみ。
    const allowed = new Set([
      "outcome",
      "photoId",
      "kind",
      "candidateKey",
      "currentKey",
      "referencedColumn",
      "sourceOutcome",
      "lineNumber",
    ]);
    for (const l of out) {
      for (const k of Object.keys(l)) expect(allowed.has(k)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------
// cleanupDryRunExitCode（純関数）
// ---------------------------------------------------------------

describe("cleanupDryRunExitCode", () => {
  it("全 deletable / 期待 skip のみ → 0", () => {
    const s = emptyCleanupSummary();
    s.deletable = 5;
    s.skipped_row_missing = 1;
    expect(cleanupDryRunExitCode(s)).toBe(CLEANUP_DRY_RUN_EXIT_OK);
  });

  it("malformed_line > 0 → 1（run-log 破損・最優先で要調査）", () => {
    const s = emptyCleanupSummary();
    s.deletable = 1;
    s.malformed_line = 1;
    expect(cleanupDryRunExitCode(s)).toBe(CLEANUP_DRY_RUN_EXIT_MALFORMED);
  });

  it("malformed 無し・skipped_still_referenced > 0 → 2（手動 rollback / 未 repoint の疑い・R2c-ii 前に要調査）", () => {
    const s = emptyCleanupSummary();
    s.deletable = 1;
    s.skipped_still_referenced = 2;
    expect(cleanupDryRunExitCode(s)).toBe(CLEANUP_DRY_RUN_EXIT_STILL_REFERENCED);
  });

  it("malformed と still_referenced 同時は 1 を優先", () => {
    const s = emptyCleanupSummary();
    s.malformed_line = 1;
    s.skipped_still_referenced = 1;
    expect(cleanupDryRunExitCode(s)).toBe(CLEANUP_DRY_RUN_EXIT_MALFORMED);
  });
});

describe("emptyCleanupSummary", () => {
  it("全 outcome を 0 で初期化する", () => {
    const s = emptyCleanupSummary();
    for (const o of CLEANUP_DRY_RUN_OUTCOMES) expect(s[o]).toBe(0);
  });
});

// ---------------------------------------------------------------
// isSameIoPath（P2-1: --apply-run-log と --out の同一ファイル検出）
// ---------------------------------------------------------------

describe("isSameIoPath", () => {
  it("同一文字列のパスは同一と判定する（--apply-run-log a.jsonl --out a.jsonl を拒否できる）", () => {
    expect(isSameIoPath("/tmp/a.jsonl", "/tmp/a.jsonl")).toBe(true);
    expect(isSameIoPath("run.jsonl", "run.jsonl")).toBe(true);
  });

  it("相対パスと、その解決先の絶対パスは同一と判定する", () => {
    expect(isSameIoPath("run.jsonl", path.resolve("run.jsonl"))).toBe(true);
    expect(isSameIoPath("./sub/../run.jsonl", path.resolve("run.jsonl"))).toBe(true);
  });

  it("大文字小文字のみ異なるパスも安全側（同一）に倒す", () => {
    // 大文字小文字非区別 FS（Windows/macOS 既定）で同一ファイルを上書きする事故を防ぐ。
    expect(isSameIoPath("/tmp/Apply.JSONL", "/tmp/apply.jsonl")).toBe(true);
  });

  it("別ファイルは false（正常に別ファイルなら従来通り動く）", () => {
    expect(isSameIoPath("/tmp/apply.jsonl", "/tmp/cleanup.jsonl")).toBe(false);
    expect(isSameIoPath("a.jsonl", "b.jsonl")).toBe(false);
  });
});

// ---------------------------------------------------------------
// apply の run-log 形との契約整合（フィールド名ドリフトの回帰防止）
// ---------------------------------------------------------------

describe("apply toRunLogLine との契約整合", () => {
  it("apply の repointed 出力（oldKey + oldThumbnailKey）をそのまま cleanup が 2 候補化できる", () => {
    const repointed: RetroStripRowResult = {
      outcome: "repointed",
      photoId: PHOTO_ID,
      oldKey: OLD_KEY,
      oldThumbnailKey: OLD_THUMB_KEY,
      newKey: NEW_KEY,
      newFileUrl: uploads(NEW_KEY),
      newThumbnailUrl: uploads(NEW_THUMB_KEY),
      bytesBefore: 1000,
      bytesAfter: 900,
    };
    const parsed = parseCleanupRunLogLine(JSON.stringify(toRunLogLine(repointed)), 1);
    expect(parsed.kind).toBe("candidates");
    if (parsed.kind === "candidates") {
      expect(parsed.candidates).toEqual([
        { kind: "file", key: OLD_KEY },
        { kind: "thumbnail", key: OLD_THUMB_KEY },
      ]);
    }
  });

  it("apply の repointed 出力（oldThumbnailKey=null は省略される）→ cleanup は file 候補のみ", () => {
    const repointed: RetroStripRowResult = {
      outcome: "repointed",
      photoId: PHOTO_ID,
      oldKey: OLD_KEY,
      oldThumbnailKey: null,
      newKey: NEW_KEY,
      newFileUrl: uploads(NEW_KEY),
      newThumbnailUrl: null,
      bytesBefore: 1000,
      bytesAfter: 900,
    };
    const line = toRunLogLine(repointed);
    expect(line.oldThumbnailKey).toBeUndefined(); // apply は null のとき field を省略する
    const parsed = parseCleanupRunLogLine(JSON.stringify(line), 1);
    expect(parsed.kind).toBe("candidates");
    if (parsed.kind === "candidates") {
      expect(parsed.candidates).toEqual([{ kind: "file", key: OLD_KEY }]);
    }
  });

  it("apply の非 repointed 出力（skipped_row_changed の newKey）は候補化されない（新 key 孤児の取り違え防止）", () => {
    const rowChanged: RetroStripRowResult = {
      outcome: "skipped_row_changed",
      photoId: PHOTO_ID,
      oldKey: OLD_KEY,
      newKey: NEW_KEY,
      compensationDeleted: true,
    };
    const parsed = parseCleanupRunLogLine(JSON.stringify(toRunLogLine(rowChanged)), 1);
    expect(parsed.kind).toBe("not_repointed");
    if (parsed.kind === "not_repointed") {
      expect(parsed.sourceOutcome).toBe("skipped_row_changed");
    }
  });
});

// ---------------------------------------------------------------
// runCleanupDelete（実削除配線・二重ゲート通過後・PR-R2c-ii）
// ---------------------------------------------------------------

function makeDeletePorts(
  rows: Record<string, CleanupCurrentRow | null>,
  opts: { failKeys?: readonly string[] } = {},
) {
  const lookupCalls: string[] = [];
  const deletes: string[] = [];
  const failKeys = new Set(opts.failKeys ?? []);
  const ports: CleanupDeletePorts = {
    async lookupRow(photoId) {
      lookupCalls.push(photoId);
      return Object.prototype.hasOwnProperty.call(rows, photoId) ? rows[photoId] : null;
    },
    async deleteObject(key) {
      deletes.push(key);
      if (failKeys.has(key)) throw new Error(`delete failure ${key}`);
    },
  };
  return { ports, deletes, lookupCalls };
}

async function runCollectDelete(lines: AsyncIterable<string>, ports: CleanupDeletePorts) {
  const out: CleanupDeleteLogLine[] = [];
  const result = await runCleanupDelete(lines, ports, (line) => {
    out.push(line);
  });
  return { result, out };
}

describe("runCleanupDelete", () => {
  it("deletable 候補のみ deleteObject が呼ばれる（oldKey + oldThumbnailKey 両方非参照→2件 deleted）", async () => {
    const { ports, deletes } = makeDeletePorts({
      [PHOTO_ID]: { fileUrl: uploads(NEW_KEY), thumbnailUrl: uploads(NEW_THUMB_KEY) },
    });
    const { result, out } = await runCollectDelete(
      linesOf(repointedLine({ oldThumbnailKey: OLD_THUMB_KEY })),
      ports,
    );
    expect(deletes).toEqual([OLD_KEY, OLD_THUMB_KEY]);
    expect(result.summary.deleted).toBe(2);
    expect(out.every((l) => l.outcome === "deleted")).toBe(true);
  });

  it("現 fileUrl に候補 key があれば削除しない（skipped_still_referenced）", async () => {
    const { ports, deletes } = makeDeletePorts({
      [PHOTO_ID]: { fileUrl: uploads(OLD_KEY), thumbnailUrl: null },
    });
    const { result, out } = await runCollectDelete(linesOf(repointedLine()), ports);
    expect(deletes).toEqual([]);
    expect(out[0].outcome).toBe("skipped_still_referenced");
    expect(result.summary.deleted).toBe(0);
  });

  it("現 thumbnailUrl に候補 key があれば削除しない（cross-column・file 候補でも thumbnailUrl 確認）", async () => {
    const { ports, deletes } = makeDeletePorts({
      [PHOTO_ID]: { fileUrl: uploads(NEW_KEY), thumbnailUrl: uploads(OLD_KEY) },
    });
    const { out } = await runCollectDelete(linesOf(repointedLine()), ports);
    expect(deletes).not.toContain(OLD_KEY);
    expect(out[0]).toMatchObject({ outcome: "skipped_still_referenced", referencedColumn: "thumbnail" });
  });

  it("thumbnail 候補でも fileUrl を確認する（cross-column）", async () => {
    const { ports, deletes } = makeDeletePorts({
      [PHOTO_ID]: { fileUrl: uploads(OLD_THUMB_KEY), thumbnailUrl: null },
    });
    const { out } = await runCollectDelete(
      linesOf(repointedLine({ oldThumbnailKey: OLD_THUMB_KEY })),
      ports,
    );
    expect(deletes).not.toContain(OLD_THUMB_KEY);
    expect(out.find((l) => l.kind === "thumbnail")).toMatchObject({
      outcome: "skipped_still_referenced",
      referencedColumn: "file",
    });
  });

  it("legacy absolute URL でも両カラム一致を検出し削除しない", async () => {
    const { ports, deletes } = makeDeletePorts({
      [PHOTO_ID]: { fileUrl: `https://example.com${uploads(OLD_KEY)}`, thumbnailUrl: null },
    });
    const { out } = await runCollectDelete(linesOf(repointedLine()), ports);
    expect(deletes).toEqual([]);
    expect(out[0].outcome).toBe("skipped_still_referenced");
  });

  it("non-null unmappable URL があれば fail-closed（削除しない）", async () => {
    const { ports, deletes } = makeDeletePorts({
      [PHOTO_ID]: { fileUrl: uploads(NEW_KEY), thumbnailUrl: "data:image/jpeg;base64,AAAA" },
    });
    const { out } = await runCollectDelete(linesOf(repointedLine()), ports);
    expect(deletes).toEqual([]);
    expect(out[0].outcome).toBe("skipped_unmappable");
  });

  it("null thumbnail は file 候補の削除を過剰に止めない", async () => {
    const { ports, deletes } = makeDeletePorts({
      [PHOTO_ID]: { fileUrl: uploads(NEW_KEY), thumbnailUrl: null },
    });
    const { out } = await runCollectDelete(linesOf(repointedLine()), ports);
    expect(deletes).toEqual([OLD_KEY]);
    expect(out[0].outcome).toBe("deleted");
  });

  it("noncanonical / ? / # key は削除しない（skipped_invalid_key）", async () => {
    const inv = makeDeletePorts({ [PHOTO_ID]: { fileUrl: uploads(NEW_KEY), thumbnailUrl: null } });
    const r1 = await runCollectDelete(linesOf(repointedLine({ oldKey: "../secret.jpg" })), inv.ports);
    expect(inv.deletes).toEqual([]);
    expect(r1.out[0].outcome).toBe("skipped_invalid_key");
    const q = makeDeletePorts({ [PHOTO_ID]: { fileUrl: uploads(NEW_KEY), thumbnailUrl: null } });
    await runCollectDelete(linesOf(repointedLine({ oldKey: `${OLD_KEY}?v=2` })), q.ports);
    expect(q.deletes).toEqual([]);
  });

  it("malformed run-log は削除しない（malformed_line）", async () => {
    const { ports, deletes } = makeDeletePorts({ [PHOTO_ID]: { fileUrl: uploads(NEW_KEY), thumbnailUrl: null } });
    const { out } = await runCollectDelete(linesOf("{broken"), ports);
    expect(deletes).toEqual([]);
    expect(out[0].outcome).toBe("malformed_line");
  });

  it("outcome !== repointed は削除しない（skipped_not_repointed・lookupRow も呼ばない）", async () => {
    const { ports, deletes, lookupCalls } = makeDeletePorts({
      [PHOTO_ID]: { fileUrl: uploads(NEW_KEY), thumbnailUrl: null },
    });
    const notRepointed = JSON.stringify({
      photoId: PHOTO_ID,
      outcome: "skipped_row_changed",
      oldKey: OLD_KEY,
      newKey: NEW_KEY,
    });
    const { out } = await runCollectDelete(linesOf(notRepointed), ports);
    expect(deletes).toEqual([]);
    expect(lookupCalls).toEqual([]);
    expect(out[0].outcome).toBe("skipped_not_repointed");
  });

  it("delete 失敗は best-effort 継続（delete_failed + errorName・後続候補も deleted）", async () => {
    const p = makeDeletePorts(
      { [PHOTO_ID]: { fileUrl: uploads(NEW_KEY), thumbnailUrl: uploads(NEW_THUMB_KEY) } },
      { failKeys: [OLD_KEY] },
    );
    const { result, out } = await runCollectDelete(
      linesOf(repointedLine({ oldThumbnailKey: OLD_THUMB_KEY })),
      p.ports,
    );
    expect(p.deletes).toEqual([OLD_KEY, OLD_THUMB_KEY]); // 1 件失敗でも後続を試行（継続）
    expect(result.summary.delete_failed).toBe(1);
    expect(result.summary.deleted).toBe(1);
    const failed = out.find((l) => l.outcome === "delete_failed");
    expect(failed).toMatchObject({ kind: "file", candidateKey: OLD_KEY, errorName: "Error" });
  });

  it("lookupRow は repointed 行ごとに 1 回（候補数に依らない）", async () => {
    const { ports, lookupCalls } = makeDeletePorts({
      [PHOTO_ID]: { fileUrl: uploads(NEW_KEY), thumbnailUrl: uploads(NEW_THUMB_KEY) },
    });
    await runCollectDelete(linesOf(repointedLine({ oldThumbnailKey: OLD_THUMB_KEY })), ports);
    expect(lookupCalls).toEqual([PHOTO_ID]);
  });

  it("非 PII: delete_failed の errorName は error.name のみ（message 本文を出さない）+ 出力は whitelist", async () => {
    const ports: CleanupDeletePorts = {
      async lookupRow() {
        return { fileUrl: uploads(NEW_KEY), thumbnailUrl: null };
      },
      async deleteObject() {
        throw new Error("SENTINEL-SECRET /uploads/owner-pii.jpg");
      },
    };
    const { out } = await runCollectDelete(linesOf(repointedLine()), ports);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("SENTINEL");
    expect(out[0]).toMatchObject({ outcome: "delete_failed", errorName: "Error" });
    const allowed = new Set([
      "outcome",
      "photoId",
      "kind",
      "candidateKey",
      "currentKey",
      "referencedColumn",
      "sourceOutcome",
      "lineNumber",
      "errorName",
    ]);
    for (const l of out) {
      for (const k of Object.keys(l)) expect(allowed.has(k)).toBe(true);
    }
  });
});

describe("cleanupDeleteExitCode", () => {
  it("全 deleted / 期待 skip のみ → 0", () => {
    const s = emptyCleanupDeleteSummary();
    s.deleted = 3;
    s.skipped_row_missing = 1;
    expect(cleanupDeleteExitCode(s)).toBe(CLEANUP_DELETE_EXIT_OK);
  });

  it("malformed_line > 0 → 1（最優先）", () => {
    const s = emptyCleanupDeleteSummary();
    s.deleted = 1;
    s.malformed_line = 1;
    s.delete_failed = 1;
    s.skipped_still_referenced = 1;
    expect(cleanupDeleteExitCode(s)).toBe(CLEANUP_DELETE_EXIT_MALFORMED);
  });

  it("malformed 無し・delete_failed > 0 → 3（orphan 残存・要対応）", () => {
    const s = emptyCleanupDeleteSummary();
    s.deleted = 1;
    s.delete_failed = 2;
    s.skipped_still_referenced = 1;
    expect(cleanupDeleteExitCode(s)).toBe(CLEANUP_DELETE_EXIT_DELETE_FAILED);
  });

  it("malformed / delete_failed 無し・skipped_still_referenced > 0 → 2", () => {
    const s = emptyCleanupDeleteSummary();
    s.deleted = 1;
    s.skipped_still_referenced = 2;
    expect(cleanupDeleteExitCode(s)).toBe(CLEANUP_DELETE_EXIT_STILL_REFERENCED);
  });
});

// ---------------------------------------------------------------
// P1: delete mode は malformed が1行でもあれば削除前に abort（pre-validation）
// ---------------------------------------------------------------

describe("preValidateCleanupRunLog", () => {
  it("全行 valid（repointed / not_repointed / blank）→ ok:true", async () => {
    const r = await preValidateCleanupRunLog(
      linesOf(
        repointedLine(),
        "",
        JSON.stringify({ photoId: PHOTO_ID, outcome: "unchanged", oldKey: OLD_KEY }),
      ),
    );
    expect(r.ok).toBe(true);
  });

  it("malformed が1件でもあれば ok:false（最初の malformed 行番号）", async () => {
    const r = await preValidateCleanupRunLog(linesOf(repointedLine(), "{broken"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.malformedLineNumber).toBe(2);
  });

  it("malformed が先頭でも検出（行番号 1）", async () => {
    const r = await preValidateCleanupRunLog(linesOf("{broken", repointedLine()));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.malformedLineNumber).toBe(1);
  });
});

// wrapper の runDelete を模した composition（pre-validate → malformed なら storage 取得 / truncate /
// delete をせず abort、通過時のみ delete）。delete 前 abort の契約を end-to-end で固定する。
async function deleteWithPreValidation(
  linesArr: string[],
  ports: CleanupDeletePorts,
  spies: { onGetStorage?: () => void; onTruncate?: () => void } = {},
): Promise<{ aborted: boolean; exitCode: number; result: CleanupDeleteResult | null }> {
  const pre = await preValidateCleanupRunLog(linesOf(...linesArr));
  if (!pre.ok) {
    // 不可逆削除の前に abort。getStorage / sink truncate / deleteObject に到達しない。
    return { aborted: true, exitCode: CLEANUP_DELETE_EXIT_MALFORMED, result: null };
  }
  spies.onGetStorage?.(); // wrapper の getStorage()（pre-validate 通過後のみ）
  spies.onTruncate?.(); // wrapper の makeJsonlSink truncate（pre-validate 通過後のみ）
  const result = await runCleanupDelete(linesOf(...linesArr), ports);
  return { aborted: false, exitCode: cleanupDeleteExitCode(result.summary), result };
}

describe("runCleanupDelete pre-validation（P1: malformed なら削除前 abort）", () => {
  it("malformed が valid deletable より前 → deleteObject 未呼出・exit 1・getStorage/truncate 未到達", async () => {
    const { ports, deletes } = makeDeletePorts({
      [PHOTO_ID]: { fileUrl: uploads(NEW_KEY), thumbnailUrl: null },
    });
    let storageGot = false;
    let truncated = false;
    const r = await deleteWithPreValidation(["{broken", repointedLine()], ports, {
      onGetStorage: () => {
        storageGot = true;
      },
      onTruncate: () => {
        truncated = true;
      },
    });
    expect(r.aborted).toBe(true);
    expect(r.exitCode).toBe(CLEANUP_DELETE_EXIT_MALFORMED);
    expect(deletes).toEqual([]);
    expect(storageGot).toBe(false);
    expect(truncated).toBe(false);
  });

  it("[P1 核心] malformed が valid deletable より後 → 先行 valid があっても deleteObject 未呼出・exit 1", async () => {
    const { ports, deletes } = makeDeletePorts({
      [PHOTO_ID]: { fileUrl: uploads(NEW_KEY), thumbnailUrl: null },
    });
    let storageGot = false;
    const r = await deleteWithPreValidation([repointedLine(), "{broken"], ports, {
      onGetStorage: () => {
        storageGot = true;
      },
    });
    expect(r.aborted).toBe(true);
    expect(r.exitCode).toBe(CLEANUP_DELETE_EXIT_MALFORMED);
    expect(deletes).toEqual([]); // 先行 valid 行があっても何も削除しない
    expect(storageGot).toBe(false);
  });

  it("全行 valid → pre-validation 通過し deletable を削除（通常動作）", async () => {
    const { ports, deletes } = makeDeletePorts({
      [PHOTO_ID]: { fileUrl: uploads(NEW_KEY), thumbnailUrl: null },
    });
    let storageGot = false;
    const r = await deleteWithPreValidation([repointedLine()], ports, {
      onGetStorage: () => {
        storageGot = true;
      },
    });
    expect(r.aborted).toBe(false);
    expect(storageGot).toBe(true);
    expect(deletes).toEqual([OLD_KEY]);
    expect(r.exitCode).toBe(CLEANUP_DELETE_EXIT_OK);
  });

  it("dry-run は従来どおり malformed_line を emit して継続（fail-before-delete は delete mode のみ）", async () => {
    const { ports } = makeLookup({
      [PHOTO_ID]: { fileUrl: uploads(NEW_KEY), thumbnailUrl: null },
    });
    const { result } = await runCollect(linesOf("{broken", repointedLine()), ports);
    expect(result.summary.malformed_line).toBe(1);
    expect(result.summary.deletable).toBe(1); // 後続 valid は dry-run では継続評価
  });
});

describe("CLEANUP_DELETE_OUTCOMES", () => {
  it("dry-run の全 outcome + deleted/delete_failed の superset（dry-run tuple は無改変）", () => {
    expect(CLEANUP_DELETE_OUTCOMES).toEqual([...CLEANUP_DRY_RUN_OUTCOMES, "deleted", "delete_failed"]);
  });

  it("emptyCleanupDeleteSummary は全 outcome を 0 初期化", () => {
    const s = emptyCleanupDeleteSummary();
    for (const o of CLEANUP_DELETE_OUTCOMES) expect(s[o]).toBe(0);
  });
});

// ---------------------------------------------------------------
// source assertion（DI 維持 / delete 導線不在 / streaming / wrapper 配線）
// ---------------------------------------------------------------

describe("retro-exif-strip-cleanup source assertion", () => {
  const libSrc = fs.readFileSync(
    path.resolve(process.cwd(), "src/lib/field-survey/retro-exif-strip-cleanup.ts"),
    "utf8",
  );
  const scriptSrc = fs.readFileSync(
    path.resolve(process.cwd(), "scripts/retro-exif-strip-cleanup-field-survey.ts"),
    "utf8",
  );

  it("cleanup lib は prisma / storage 実体 / next / node:fs を import しない（DI 維持）", () => {
    expect(libSrc).not.toContain("@/lib/prisma");
    expect(libSrc).not.toContain("generated/prisma");
    expect(libSrc).not.toContain("getStorage");
    expect(libSrc).not.toContain('from "next');
    expect(libSrc).not.toContain('from "node:fs');
    expect(libSrc).not.toContain('from "fs"');
    expect(libSrc).not.toContain("readFileSync");
  });

  it("cleanup lib に storage delete 導線が無い（R2c-i は列挙のみ・delete は PR-R2c-ii）", () => {
    // isValidStorageKey / extractStorageKeyFromStoredFileUrl は key 検証用に import するが、
    // StorageAdapter（read/upload/delete）や実 delete 呼び出しは一切持たない。
    expect(libSrc).not.toContain("storage.delete");
    expect(libSrc).not.toContain(".delete(");
    expect(libSrc).not.toContain("StorageAdapter");
  });

  it("dry-run runner は結果配列を保持せず outcome を per-row streaming 集計する", () => {
    expect(libSrc).toContain("summary[evaluation.outcome] += 1");
    expect(libSrc).not.toContain("evaluations.push");
  });

  it("delete runner（runCleanupDelete）も結果配列を保持せず per-row streaming 集計する", () => {
    expect(libSrc).toContain("summary[line.outcome] += 1");
  });

  it("cleanup lib は storage.delete / getStorage を直接持たず deleteObject port 経由（R2c-ii）", () => {
    // 実 delete は wrapper が注入する deleteObject port 経由。lib は storage 実体を import/呼出しない。
    // deleteObject 命名により '.delete(' substring も踏まない。
    expect(libSrc).not.toContain("storage.delete");
    expect(libSrc).not.toContain(".delete(");
    expect(libSrc).not.toContain("getStorage");
    expect(libSrc).toContain("deleteObject");
  });

  it("wrapper の実削除導線は二重ゲート（--delete && --confirm）の内側にのみ置かれる（getStorage/storage.delete が confirm ゲートより後）", () => {
    // R2c-ii では wrapper が getStorage()/storage.delete を持つが、confirm ゲートの後にのみ到達する。
    // 素の禁止 not.toContain では検出できないため、ordering で『confirm ゲート → getStorage → storage.delete』
    // を固定する。本質保証は runtime fake-deleteObject テスト（--delete 単独/dry-run で deletes 空）。
    const gateIdx = scriptSrc.indexOf("options.confirm");
    const getStorageIdx = scriptSrc.indexOf("getStorage(");
    const deleteIdx = scriptSrc.indexOf("storage.delete(");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(getStorageIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(getStorageIdx);
    expect(getStorageIdx).toBeLessThan(deleteIdx);
  });

  it("wrapper は DB 行削除（fieldSurveyPinPhoto.delete）を持たない（R2c-ii は純 storage 削除・DB 非削除）", () => {
    expect(scriptSrc).not.toContain("fieldSurveyPinPhoto.delete");
    expect(scriptSrc).not.toContain(".update(");
    expect(scriptSrc).not.toContain(".create(");
  });

  it("wrapper の実削除は pre-validation（preValidateCleanupRunLog）を getStorage / 削除より前に行う（P1: malformed なら storage 取得前に abort）", () => {
    // 不可逆削除ゆえ、run-log に malformed が1行でもあれば getStorage / sink truncate / deleteObject に
    // 到達する前に abort する。本質保証は runtime composition テスト（malformed→deletes 空・storage 未取得）。
    expect(scriptSrc).toContain("preValidateCleanupRunLog");
    const preIdx = scriptSrc.indexOf("preValidateCleanupRunLog(");
    const getStorageIdx = scriptSrc.indexOf("getStorage(");
    expect(preIdx).toBeGreaterThan(-1);
    expect(getStorageIdx).toBeGreaterThan(-1);
    expect(preIdx).toBeLessThan(getStorageIdx);
  });

  it("wrapper は STORAGE_BACKEND fail-closed を維持する（resolveApplyStorageBackend / assertSafeEnvironment 流用）", () => {
    expect(scriptSrc).toContain("resolveApplyStorageBackend");
    expect(scriptSrc).toContain("assertSafeEnvironment");
  });

  it("wrapper は入力 run-log を readline で逐次読みし、findUnique で DB 再確認する", () => {
    // 全文一括 read（readFileSync）でバッファせず streaming で畳み込む。
    expect(scriptSrc).toContain("parseCleanupCliArgs");
    expect(scriptSrc).toContain("createInterface");
    expect(scriptSrc).toContain("findUnique");
    expect(scriptSrc).not.toContain("readFileSync");
  });

  it("wrapper は --apply-run-log と --out の同一パスを、出力 sink（truncate）より前に拒否する（P2-1）", () => {
    // makeJsonlSink(options.outPath) は writeFileSync(outPath,"") で truncate するため、
    // 入力 run-log の破壊を防ぐべく isSameIoPath ガードを sink 呼び出しより前に置く。
    expect(scriptSrc).toContain("isSameIoPath");
    const guardIdx = scriptSrc.indexOf("isSameIoPath(");
    const sinkCallIdx = scriptSrc.indexOf("makeJsonlSink(options.outPath");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(sinkCallIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(sinkCallIdx);
  });
});
