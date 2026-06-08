/**
 * 遡及 EXIF strip inventory / dry-run CLI core（retro-exif-strip-cli.ts・PR-R2a）の単体テスト。
 *
 * 方針:
 *   - prisma / storage 実体 / process を一切使わない。合成バイト fixture + mock ports のみ。
 *   - dry-run 専用であること（upload / delete / repoint が呼ばれないこと）を強くロックする。
 *   - --apply は parse 時点で error になることをロックする。
 *   - 出力（run-log 行）に fileName / 座標 / PII が混入しないことをロックする。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  parseRetroStripCliArgs,
  assertSafeEnvironment,
  classifyInventoryRow,
  aggregateInventory,
  emptyInventorySummary,
  accumulateInventoryRow,
  toRunLogLine,
  runRetroStripDryRun,
  makeDryRunPorts,
  emptyOutcomeSummary,
  type InventoryRowInput,
} from "@/lib/field-survey/retro-exif-strip-cli";
import { RETRO_STRIP_OUTCOMES, type RetroStripRowInput } from "@/lib/field-survey/retro-exif-strip";

// ---------------------------------------------------------------
// 合成 JPEG fixture（field-survey-retro-exif-strip.test.ts と同方針）
// ---------------------------------------------------------------

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const len = payload.length + 2;
  return Buffer.concat([
    Buffer.from([0xff, marker, (len >> 8) & 0xff, len & 0xff]),
    payload,
  ]);
}

const SOS_TAIL = Buffer.concat([
  Buffer.from([0xff, 0xda, 0x00, 0x04, 0x01, 0x02]),
  Buffer.from([0xab, 0xcd, 0x5a, 0x3c]),
  EOI,
]);

function buildJpegWithApp1(): Buffer {
  const app1Payload = Buffer.concat([
    Buffer.from("Exif\0\0", "latin1"),
    Buffer.from("XXNOT-A-TIFF-JUNK", "latin1"),
  ]);
  return Buffer.concat([SOI, jpegSegment(0xe1, app1Payload), jpegSegment(0xe0, Buffer.from("JFIF\0", "latin1")), SOS_TAIL]);
}

function buildCleanJpeg(): Buffer {
  return Buffer.concat([SOI, jpegSegment(0xe0, Buffer.from("JFIF\0", "latin1")), SOS_TAIL]);
}

/** JPEG として構造不正（SOI 不在）= strip 側で malformed になる。 */
const MALFORMED_BYTES = Buffer.from("not-a-jpeg", "latin1");

// ---------------------------------------------------------------
// parseRetroStripCliArgs
// ---------------------------------------------------------------

describe("parseRetroStripCliArgs", () => {
  it("--inventory を受理する", () => {
    const r = parseRetroStripCliArgs(["--inventory"]);
    expect(r).toEqual({
      ok: true,
      options: { mode: "inventory", jsonlPath: null, batchSize: 500, limit: null, help: false },
    });
  });

  it("--dry-run + --jsonl + --batch-size + --limit を受理する", () => {
    const r = parseRetroStripCliArgs([
      "--dry-run",
      "--jsonl",
      "/tmp/out.jsonl",
      "--batch-size",
      "100",
      "--limit",
      "10",
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.options).toEqual({
      mode: "dry-run",
      jsonlPath: "/tmp/out.jsonl",
      batchSize: 100,
      limit: 10,
      help: false,
    });
  });

  it("--apply は error（dry-run 専用・apply 未実装）", () => {
    const r = parseRetroStripCliArgs(["--apply"]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toContain("--apply");
  });

  it("--dry-run --apply のように apply が混ざっても error", () => {
    const r = parseRetroStripCliArgs(["--dry-run", "--apply"]);
    expect(r.ok).toBe(false);
  });

  it("mode 未指定は error", () => {
    const r = parseRetroStripCliArgs([]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toContain("--inventory");
  });

  it("--inventory --dry-run の併用（排他違反）は error", () => {
    const r = parseRetroStripCliArgs(["--inventory", "--dry-run"]);
    expect(r.ok).toBe(false);
  });

  it("未知のオプションは error", () => {
    const r = parseRetroStripCliArgs(["--inventory", "--wat"]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toContain("--wat");
  });

  it.each([
    ["--batch-size", "0"],
    ["--batch-size", "-3"],
    ["--batch-size", "abc"],
    ["--limit", "0"],
    ["--limit", "1.5"],
  ])("%s %s（不正値）は error", (flag, value) => {
    const r = parseRetroStripCliArgs(["--dry-run", flag, value]);
    expect(r.ok).toBe(false);
  });

  it("--jsonl の値が無い/次がフラグなら error", () => {
    expect(parseRetroStripCliArgs(["--dry-run", "--jsonl"]).ok).toBe(false);
    expect(parseRetroStripCliArgs(["--dry-run", "--jsonl", "--limit"]).ok).toBe(false);
  });

  it("--help は mode 不要で受理（help=true）", () => {
    const r = parseRetroStripCliArgs(["--help"]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.options.help).toBe(true);
  });
});

// ---------------------------------------------------------------
// assertSafeEnvironment
// ---------------------------------------------------------------

describe("assertSafeEnvironment", () => {
  it("通常環境は ok", () => {
    expect(assertSafeEnvironment({})).toEqual({ ok: true });
    expect(assertSafeEnvironment({ NEXT_PUBLIC_USE_MOCK: "false" })).toEqual({ ok: true });
  });

  it("NEXT_PUBLIC_USE_MOCK=true は停止", () => {
    const r = assertSafeEnvironment({ NEXT_PUBLIC_USE_MOCK: "true" });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("NEXT_PUBLIC_USE_MOCK");
  });
});

// ---------------------------------------------------------------
// inventory 分類 / 集計
// ---------------------------------------------------------------

const PIN = "11111111-1111-4111-8111-111111111111";

describe("classifyInventoryRow / aggregateInventory", () => {
  it("相対 /uploads canonical key + jpeg は mappable / supported / 非 absolute", () => {
    const c = classifyInventoryRow({
      id: "p1",
      fileUrl: `/uploads/field-survey/pins/${PIN}/photos/a.jpg`,
      thumbnailUrl: null,
      mimeType: "image/jpeg",
    });
    expect(c).toMatchObject({
      mappable: true,
      absoluteLegacy: false,
      supportedMime: true,
      unsupportedMime: false,
      hasThumbnail: false,
    });
  });

  it("legacy absolute /uploads URL は mappable かつ absoluteLegacy", () => {
    const c = classifyInventoryRow({
      id: "p2",
      fileUrl: `https://example.com/uploads/field-survey/pins/${PIN}/photos/a.jpg`,
      thumbnailUrl: `/uploads/field-survey/thumbs/t.jpg`,
      mimeType: "image/jpeg",
    });
    expect(c.mappable).toBe(true);
    expect(c.absoluteLegacy).toBe(true);
    expect(c.hasThumbnail).toBe(true);
    expect(c.thumbnailMappable).toBe(true);
  });

  it("HEIC は unsupportedMime", () => {
    const c = classifyInventoryRow({
      id: "p3",
      fileUrl: `/uploads/field-survey/pins/${PIN}/photos/a.heic`,
      thumbnailUrl: null,
      mimeType: "image/heic",
    });
    expect(c.supportedMime).toBe(false);
    expect(c.unsupportedMime).toBe(true);
    expect(c.mappable).toBe(true);
  });

  it.each([
    ["非 /uploads absolute", "https://example.com/files/a.jpg"],
    ["data URL", "data:image/jpeg;base64,AAAA"],
    ["backslash key", "/uploads/field-survey\\a.jpg"],
    ["連続スラッシュ key", "/uploads/field-survey//a.jpg"],
  ])("%s は unmappable", (_label, fileUrl) => {
    const c = classifyInventoryRow({ id: "x", fileUrl, thumbnailUrl: null, mimeType: "image/jpeg" });
    expect(c.mappable).toBe(false);
    expect(c.absoluteLegacy).toBe(false);
  });

  it("aggregateInventory は各カウントを正しく集計する", () => {
    const rows: InventoryRowInput[] = [
      { id: "1", fileUrl: `/uploads/field-survey/pins/${PIN}/photos/a.jpg`, thumbnailUrl: null, mimeType: "image/jpeg" }, // mappable/supported
      { id: "2", fileUrl: `https://h/uploads/field-survey/pins/${PIN}/photos/b.png`, thumbnailUrl: `/uploads/t/b.jpg`, mimeType: "image/png" }, // mappable/supported/absolute/thumb
      { id: "3", fileUrl: `/uploads/field-survey/pins/${PIN}/photos/c.heic`, thumbnailUrl: null, mimeType: "image/heic" }, // mappable/unsupported
      { id: "4", fileUrl: "https://h/files/d.jpg", thumbnailUrl: null, mimeType: "image/jpeg" }, // unmappable
      { id: "5", fileUrl: "/uploads/field-survey//e.jpg", thumbnailUrl: null, mimeType: "image/jpeg" }, // unmappable(非canonical)
    ];
    const s = aggregateInventory(rows);
    expect(s.total).toBe(5);
    expect(s.byMimeType).toEqual({ "image/jpeg": 3, "image/png": 1, "image/heic": 1 });
    expect(s.mappable).toBe(3);
    expect(s.unmappable).toBe(2);
    expect(s.absoluteLegacy).toBe(1);
    expect(s.supportedAndMappable).toBe(2); // jpeg(1) + png(2)。heic は unsupported, 4/5 は unmappable
    expect(s.unsupportedMime).toBe(1);
    expect(s.withThumbnail).toBe(1);
    expect(s.thumbnailMappable).toBe(1);
  });

  it("streaming fold（accumulateInventoryRow）は aggregateInventory（一括）と一致する", () => {
    const rows: InventoryRowInput[] = [
      { id: "1", fileUrl: `/uploads/field-survey/pins/${PIN}/photos/a.jpg`, thumbnailUrl: null, mimeType: "image/jpeg" },
      { id: "2", fileUrl: `https://h/uploads/field-survey/pins/${PIN}/photos/b.png`, thumbnailUrl: `/uploads/t/b.jpg`, mimeType: "image/png" },
      { id: "3", fileUrl: `/uploads/field-survey/pins/${PIN}/photos/c.heic`, thumbnailUrl: null, mimeType: "image/heic" },
      { id: "4", fileUrl: "https://h/files/d.jpg", thumbnailUrl: null, mimeType: "image/jpeg" },
    ];
    const streamed = emptyInventorySummary();
    for (const r of rows) accumulateInventoryRow(streamed, r);
    expect(streamed).toEqual(aggregateInventory(rows));
  });
});

// ---------------------------------------------------------------
// dry-run（mock storage・書き込み不発）
// ---------------------------------------------------------------

const OLD_KEY = `field-survey/pins/${PIN}/photos/old.jpg`;
const OLD_URL = `/uploads/${OLD_KEY}`;
const SENTINEL_NAME = "SENTINEL-PII-FILENAME.jpg";

function row(overrides: Partial<RetroStripRowInput> = {}): RetroStripRowInput {
  return {
    id: "photo-1",
    pinId: PIN,
    fileUrl: OLD_URL,
    thumbnailUrl: null,
    fileName: SENTINEL_NAME,
    mimeType: "image/jpeg",
    ...overrides,
  };
}

async function* asyncRows(items: RetroStripRowInput[]): AsyncGenerator<RetroStripRowInput> {
  for (const it of items) yield it;
}

interface ReadFake {
  read: (key: string) => Promise<{ body: Buffer; contentType: string; size: number } | null>;
  reads: string[];
}

function readFake(files: Record<string, Buffer>): ReadFake {
  const reads: string[] = [];
  return {
    reads,
    read: async (key) => {
      reads.push(key);
      const body = files[key];
      if (!body) return null;
      return { body, contentType: "application/octet-stream", size: body.length };
    },
  };
}

describe("runRetroStripDryRun", () => {
  it("dry-run の全 outcome（would_strip/unchanged/unmappable/unsupported/missing/malformed/failed）を集計し、書き込みを一切しない", async () => {
    const clean = `field-survey/pins/${PIN}/photos/clean.jpg`;
    const malformedKey = `field-survey/pins/${PIN}/photos/broken.jpg`;
    const failKey = `field-survey/pins/${PIN}/photos/fail.jpg`;
    const baseRead = readFake({
      [OLD_KEY]: buildJpegWithApp1(),
      [clean]: buildCleanJpeg(),
      [malformedKey]: MALFORMED_BYTES,
    });
    // failKey の read だけ throw させる（read stage の failed を作る）。
    const read: typeof baseRead.read = async (key) => {
      if (key === failKey) throw new TypeError("read boom");
      return baseRead.read(key);
    };
    const ports = makeDryRunPorts(read);
    const lines: unknown[] = [];

    const items = [
      row(), // would_strip
      row({ id: "p2", fileUrl: `/uploads/${clean}` }), // unchanged
      row({ id: "p3", fileUrl: "https://h/files/x.jpg" }), // skipped_unmappable_url
      row({ id: "p4", mimeType: "image/heic" }), // skipped_unsupported_mime
      row({ id: "p5", fileUrl: `/uploads/field-survey/pins/${PIN}/photos/missing.jpg` }), // skipped_missing_bytes
      row({ id: "p6", fileUrl: `/uploads/${malformedKey}` }), // skipped_malformed
      row({ id: "p7", fileUrl: `/uploads/${failKey}` }), // failed(read)
    ];

    const result = await runRetroStripDryRun(asyncRows(items), ports, (l) => {
      lines.push(l);
    });

    expect(result.processed).toBe(7);
    expect(result.summary.would_strip).toBe(1);
    expect(result.summary.unchanged).toBe(1);
    expect(result.summary.skipped_unmappable_url).toBe(1);
    expect(result.summary.skipped_unsupported_mime).toBe(1);
    expect(result.summary.skipped_missing_bytes).toBe(1);
    expect(result.summary.skipped_malformed).toBe(1);
    expect(result.summary.failed).toBe(1);
    // apply 系 outcome は dry-run で発生しない
    expect(result.summary.repointed).toBe(0);
    expect(result.summary.skipped_row_changed).toBe(0);
    // run-log 行数 = 処理件数
    expect(lines).toHaveLength(7);
    // failed 行は stage/errorName のみ（メッセージ本文なし）
    expect(lines).toContainEqual({
      photoId: "p7",
      outcome: "failed",
      stage: "read",
      errorName: "TypeError",
    });
  });

  it("makeDryRunPorts の upload/delete/repoint は呼ぶと throw（多層防御）", async () => {
    const ports = makeDryRunPorts(async () => null);
    await expect(
      ports.storage.upload(Buffer.from("x"), { key: "k", mimeType: "image/jpeg", fileName: "f" }),
    ).rejects.toThrow();
    await expect(ports.storage.delete("k")).rejects.toThrow();
    await expect(
      ports.repointPhoto({ id: "i", expectedFileUrl: "u", newFileUrl: "n", newThumbnailUrl: null, newFileSize: 1 }),
    ).rejects.toThrow();
  });

  it("dry-run の run-log / 結果に fileName（センチネル PII）が一切漏れない", async () => {
    const clean = `field-survey/pins/${PIN}/photos/clean.jpg`;
    const f = readFake({ [OLD_KEY]: buildJpegWithApp1(), [clean]: buildCleanJpeg() });
    const ports = makeDryRunPorts(f.read);
    const lines: unknown[] = [];
    const items = [
      row(),
      row({ id: "p2", fileUrl: `/uploads/${clean}` }),
      row({ id: "p3", fileUrl: "https://h/files/x.jpg" }),
      row({ id: "p4", mimeType: "image/heic" }),
    ];
    const result = await runRetroStripDryRun(asyncRows(items), ports, (l) => {
      lines.push(l);
    });
    const serialized = JSON.stringify({ lines, result });
    expect(serialized).not.toContain("SENTINEL-PII-FILENAME");
  });

  it("would_strip の run-log 行は oldKey / bytesBefore / bytesAfter を持ち、fileName は持たない", async () => {
    const fixture = buildJpegWithApp1();
    const f = readFake({ [OLD_KEY]: fixture });
    const ports = makeDryRunPorts(f.read);
    const lines: ReturnType<typeof toRunLogLine>[] = [];
    await runRetroStripDryRun(asyncRows([row()]), ports, (l) => {
      lines.push(l);
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      photoId: "photo-1",
      outcome: "would_strip",
      oldKey: OLD_KEY,
    });
    expect(lines[0].bytesBefore).toBe(fixture.length);
    expect(lines[0].bytesAfter).toBeLessThan(fixture.length);
    expect(JSON.stringify(lines[0])).not.toContain("fileName");
  });
});

// ---------------------------------------------------------------
// toRunLogLine の whitelist（outcome 別）
// ---------------------------------------------------------------

describe("toRunLogLine", () => {
  it("skipped_unmappable_url は photoId + outcome のみ", () => {
    expect(toRunLogLine({ outcome: "skipped_unmappable_url", photoId: "x" })).toEqual({
      photoId: "x",
      outcome: "skipped_unmappable_url",
    });
  });

  it("skipped_unsupported_mime は mimeType を含む", () => {
    expect(
      toRunLogLine({ outcome: "skipped_unsupported_mime", photoId: "x", mimeType: "image/heic" }),
    ).toEqual({ photoId: "x", outcome: "skipped_unsupported_mime", mimeType: "image/heic" });
  });

  it("failed は stage / errorName を含む（メッセージ本文なし）", () => {
    expect(
      toRunLogLine({ outcome: "failed", photoId: "x", stage: "read", errorName: "TypeError" }),
    ).toEqual({ photoId: "x", outcome: "failed", stage: "read", errorName: "TypeError" });
  });

  it.each([
    ["unchanged", { outcome: "unchanged" as const, photoId: "x", oldKey: OLD_KEY }],
    ["skipped_malformed", { outcome: "skipped_malformed" as const, photoId: "x", oldKey: OLD_KEY }],
    [
      "skipped_missing_bytes",
      { outcome: "skipped_missing_bytes" as const, photoId: "x", oldKey: OLD_KEY },
    ],
  ])("%s は photoId + outcome + oldKey のみ（PII フィールドを持たない）", (_label, result) => {
    const line = toRunLogLine(result);
    expect(line).toEqual({ photoId: "x", outcome: result.outcome, oldKey: OLD_KEY });
    // 非 PII: fileName / newFileUrl / thumbnail / 座標フィールドを持たない
    const json = JSON.stringify(line);
    expect(json).not.toContain("fileName");
    expect(json).not.toContain("thumbnail");
    expect(json).not.toContain("newFileUrl");
  });

  it("would_strip は oldKey + bytes のみ（fileName を持たない）", () => {
    const line = toRunLogLine({
      outcome: "would_strip",
      photoId: "x",
      oldKey: OLD_KEY,
      bytesBefore: 100,
      bytesAfter: 60,
    });
    expect(line).toEqual({
      photoId: "x",
      outcome: "would_strip",
      oldKey: OLD_KEY,
      bytesBefore: 100,
      bytesAfter: 60,
    });
    expect(JSON.stringify(line)).not.toContain("fileName");
  });
});

describe("emptyOutcomeSummary", () => {
  it("全 outcome キーを 0 初期化する", () => {
    const s = emptyOutcomeSummary();
    expect(Object.keys(s).sort()).toEqual([...RETRO_STRIP_OUTCOMES].sort());
    expect(Object.values(s).every((v) => v === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------
// source assertion（dry-run 専用・書き込み導線の不在をロック）
// ---------------------------------------------------------------

describe("retro-exif-strip-cli source assertion", () => {
  const libSrc = fs.readFileSync(
    path.resolve(process.cwd(), "src/lib/field-survey/retro-exif-strip-cli.ts"),
    "utf8",
  );
  const scriptSrc = fs.readFileSync(
    path.resolve(process.cwd(), "scripts/retro-exif-strip-field-survey.ts"),
    "utf8",
  );

  it("lib は prisma / storage 実体 / next を import しない（DI）", () => {
    expect(libSrc).not.toContain("@/lib/prisma");
    expect(libSrc).not.toContain("generated/prisma");
    expect(libSrc).not.toContain("getStorage");
    expect(libSrc).not.toContain('from "next');
  });

  it("dry-run runner は結果配列を保持せず outcome を per-row 集計する（Codex P2・streaming）", () => {
    // 全件 dry-run でヒープが行数比例で増えないこと（buffered-then-summarize の不再導入）。
    expect(libSrc).toContain("summary[result.outcome] += 1");
    expect(libSrc).not.toContain("summarizeRetroStripResults");
  });

  it("script は書き込み導線を持たない（dry-run 専用・storage read + prisma findMany のみ）", () => {
    // 注: この textual grep は best-effort のガード（alias 経由や空白入りの記述は素通りし得る）。
    // 「書き込みが起きない」ことの本質的な保証は makeDryRunPorts の throw スタブ +
    // processRetroStripRow(mode:"dry-run") の早期 return（上の runtime テストでロック済み）。
    // 本テストは「明白な regression（直接の write 呼び出し追加）」を追加で弾く位置づけ。
    expect(scriptSrc).not.toContain("storage.upload(");
    expect(scriptSrc).not.toContain("storage.delete(");
    expect(scriptSrc).not.toContain(".update(");
    expect(scriptSrc).not.toContain("updateMany");
    expect(scriptSrc).not.toContain(".create(");
    // prisma は findMany（READ）のみを使う
    expect(scriptSrc).toContain("findMany");
    expect(scriptSrc).toContain("storage.read(");
    // --apply の受理は lib parser がエラーにする（parse 段でロック済み・別 it）。
    // wrapper は parseRetroStripCliArgs に委譲し、自前で apply 分岐を持たない。
    expect(scriptSrc).toContain("parseRetroStripCliArgs");
  });
});
