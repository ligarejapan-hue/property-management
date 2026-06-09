/**
 * 遡及 EXIF strip inventory / dry-run / apply CLI core（retro-exif-strip-cli.ts）の単体テスト。
 *
 * 方針:
 *   - prisma / storage 実体 / process を一切使わない。合成バイト fixture + mock ports のみ。
 *   - dry-run は upload / delete / repoint が呼ばれないことを強くロックする
 *     （PR-R2b で apply 導線が増えても dry-run の no-write 不変条件は維持）。
 *   - apply（PR-R2b）は --apply 受理 / makeApplyPorts + makeUpdateManyRepointPhoto の配線 /
 *     count=1→repointed・count=0→skipped_row_changed（新 key のみ補償削除・旧 key 不可侵）/
 *     upload・repoint 例外→failed / exit-code / 非 PII run-log をロックする。
 *   - core（processRetroStripRow の各分岐）は PR-R1 でロック済みのため再テストしない。
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
  runRetroStripApply,
  makeDryRunPorts,
  makeApplyPorts,
  makeUpdateManyRepointPhoto,
  applyExitCode,
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

  it("--apply を受理する（PR-R2b で apply 実装済み）", () => {
    const r = parseRetroStripCliArgs(["--apply"]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.options).toEqual({
      mode: "apply",
      jsonlPath: null,
      batchSize: 500,
      limit: null,
      help: false,
    });
  });

  it("--apply + --jsonl + --batch-size + --limit を受理する", () => {
    const r = parseRetroStripCliArgs([
      "--apply",
      "--jsonl",
      "/tmp/apply.jsonl",
      "--batch-size",
      "200",
      "--limit",
      "5",
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.options).toEqual({
      mode: "apply",
      jsonlPath: "/tmp/apply.jsonl",
      batchSize: 200,
      limit: 5,
      help: false,
    });
  });

  it("--dry-run --apply のように mode を 2 つ指定すると排他違反 error", () => {
    const r = parseRetroStripCliArgs(["--dry-run", "--apply"]);
    expect(r.ok).toBe(false);
  });

  it("--inventory --apply の併用（排他違反）は error", () => {
    const r = parseRetroStripCliArgs(["--inventory", "--apply"]);
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
// apply（PR-R2b）: makeUpdateManyRepointPhoto / makeApplyPorts / runRetroStripApply / applyExitCode
// ---------------------------------------------------------------

const NEW_KEY = `field-survey/pins/${PIN}/photos/uuid-fixed.jpg`;

describe("makeUpdateManyRepointPhoto", () => {
  it("repoint を updateMany({where:{id,fileUrl}, data:{fileUrl,thumbnailUrl,fileSize}}) に写像し count を返す", async () => {
    let captured: unknown = null;
    const repoint = makeUpdateManyRepointPhoto((args) => {
      captured = args;
      return Promise.resolve({ count: 1 });
    });
    const count = await repoint({
      id: "photo-9",
      expectedFileUrl: OLD_URL,
      newFileUrl: `/uploads/${NEW_KEY}`,
      newThumbnailUrl: null,
      newFileSize: 1234,
    });
    expect(count).toBe(1);
    // 楽観ガード = where に {id, fileUrl(=読み取り時 verbatim)} を使う（version/updatedAt 列が無いため）。
    expect(captured).toEqual({
      where: { id: "photo-9", fileUrl: OLD_URL },
      data: {
        fileUrl: `/uploads/${NEW_KEY}`,
        thumbnailUrl: null,
        fileSize: 1234,
      },
    });
  });

  it("data に mimeType を含めない（format 保持＝mime 不変）", async () => {
    let capturedData: Record<string, unknown> = {};
    const repoint = makeUpdateManyRepointPhoto((args) => {
      capturedData = args.data as unknown as Record<string, unknown>;
      return Promise.resolve({ count: 1 });
    });
    await repoint({
      id: "i",
      expectedFileUrl: "u",
      newFileUrl: "/uploads/n.jpg",
      newThumbnailUrl: "/uploads/t.jpg",
      newFileSize: 1,
    });
    expect(Object.keys(capturedData).sort()).toEqual(["fileSize", "fileUrl", "thumbnailUrl"]);
    expect(capturedData).not.toHaveProperty("mimeType");
  });

  it("count=0（楽観ガード負け）をそのまま返す", async () => {
    const repoint = makeUpdateManyRepointPhoto(() => Promise.resolve({ count: 0 }));
    await expect(
      repoint({ id: "i", expectedFileUrl: "u", newFileUrl: "n", newThumbnailUrl: null, newFileSize: 1 }),
    ).resolves.toBe(0);
  });
});

describe("makeApplyPorts", () => {
  it("注入した storage / repointPhoto / generateUuid をそのまま ports に組む（DI・実体は注入側）", () => {
    const read = async () => null;
    const upload = async () => ({ url: "u", key: "k" });
    const del = async () => {};
    const repointPhoto = async () => 1;
    const generateUuid = () => "x";
    const ports = makeApplyPorts({
      storage: { read, upload, delete: del },
      repointPhoto,
      generateUuid,
    });
    expect(ports.storage.read).toBe(read);
    expect(ports.storage.upload).toBe(upload);
    expect(ports.storage.delete).toBe(del);
    expect(ports.repointPhoto).toBe(repointPhoto);
    expect(ports.generateUuid).toBe(generateUuid);
  });
});

interface ApplyFakeOptions {
  files: Record<string, Buffer>;
  uploadThrows?: boolean;
  repointCount?: number;
  repointThrows?: boolean;
}

function applyFake(opts: ApplyFakeOptions) {
  const deletes: string[] = [];
  const uploads: string[] = [];
  const repoints: {
    id: string;
    expectedFileUrl: string;
    newFileUrl: string;
    newThumbnailUrl: string | null;
    newFileSize: number;
  }[] = [];
  const ports = makeApplyPorts({
    storage: {
      read: async (key) => {
        const body = opts.files[key];
        if (!body) return null;
        return { body, contentType: "application/octet-stream", size: body.length };
      },
      upload: async (_buffer, o) => {
        if (opts.uploadThrows) throw new TypeError("upload boom");
        uploads.push(o.key);
        return { url: `/uploads/${o.key}`, key: o.key };
      },
      delete: async (key) => {
        deletes.push(key);
      },
    },
    repointPhoto: async (u) => {
      repoints.push(u);
      if (opts.repointThrows) throw new TypeError("repoint boom");
      return opts.repointCount ?? 1;
    },
    generateUuid: () => "uuid-fixed",
  });
  return { ports, deletes, uploads, repoints };
}

describe("runRetroStripApply", () => {
  it("count=1 → repointed。旧 key は削除されず、新 key で repoint される", async () => {
    const fixture = buildJpegWithApp1();
    const fake = applyFake({ files: { [OLD_KEY]: fixture }, repointCount: 1 });
    const lines: ReturnType<typeof toRunLogLine>[] = [];
    const result = await runRetroStripApply(asyncRows([row()]), fake.ports, (l) => {
      lines.push(l);
    });

    expect(result.processed).toBe(1);
    expect(result.summary.repointed).toBe(1);
    // 旧 key は決して削除しない（rollback 窓・cleanup は PR-R2c）。
    expect(fake.deletes).toEqual([]);
    expect(fake.uploads).toEqual([NEW_KEY]);
    // repoint は楽観ガード（expectedFileUrl = 読み取り時 fileUrl verbatim）で新 key を指す。
    expect(fake.repoints).toHaveLength(1);
    expect(fake.repoints[0].expectedFileUrl).toBe(OLD_URL);
    expect(fake.repoints[0].newFileUrl).toBe(`/uploads/${NEW_KEY}`);
    expect(fake.repoints[0].newFileSize).toBeLessThan(fixture.length); // strip 後バイト
    // run-log: repointed は oldKey/newKey/bytes を持ち、newFileUrl/fileName を持たない。
    expect(lines[0]).toMatchObject({
      photoId: "photo-1",
      outcome: "repointed",
      oldKey: OLD_KEY,
      newKey: NEW_KEY,
    });
    expect(lines[0].bytesAfter as number).toBeLessThan(lines[0].bytesBefore as number);
    const json = JSON.stringify(lines[0]);
    expect(json).not.toContain("newFileUrl");
    expect(json).not.toContain("SENTINEL-PII-FILENAME");
  });

  it("repointed: 旧 thumbnail を持つ行は oldThumbnailKey が非 PII の path で run-log に乗り、旧 thumbnail key も削除されない（配線の thumbnail 透過）", async () => {
    // 不変条件 A（旧 thumbnail key 不削除）と C（thumbnail 側の非 PII 透過）を wrapper→core→
    // runner→sink の鎖で統合検証する（toRunLogLine の oldThumbnailKey 非 null 分岐を end-to-end で通す）。
    const fake = applyFake({ files: { [OLD_KEY]: buildJpegWithApp1() }, repointCount: 1 });
    const lines: ReturnType<typeof toRunLogLine>[] = [];
    const result = await runRetroStripApply(
      asyncRows([row({ thumbnailUrl: "/uploads/field-survey/thumbs/old-t.jpg" })]),
      fake.ports,
      (l) => {
        lines.push(l);
      },
    );
    expect(result.summary.repointed).toBe(1);
    // 旧 key も旧 thumbnail key も削除しない（rollback 窓・cleanup は PR-R2c）。
    expect(fake.deletes).toEqual([]);
    expect(lines[0]).toMatchObject({
      photoId: "photo-1",
      outcome: "repointed",
      oldKey: OLD_KEY,
      oldThumbnailKey: "field-survey/thumbs/old-t.jpg",
      newKey: NEW_KEY,
    });
    // 非 PII: newFileUrl / newThumbnailUrl / fileName は run-log に出さない。
    const json = JSON.stringify(lines[0]);
    expect(json).not.toContain("newFileUrl");
    expect(json).not.toContain("newThumbnailUrl");
    expect(json).not.toContain("SENTINEL-PII-FILENAME");
  });

  it("count=0（並行変更）→ skipped_row_changed。新 key のみ補償削除（旧 key は不可侵）", async () => {
    const fake = applyFake({ files: { [OLD_KEY]: buildJpegWithApp1() }, repointCount: 0 });
    const lines: ReturnType<typeof toRunLogLine>[] = [];
    const result = await runRetroStripApply(asyncRows([row()]), fake.ports, (l) => {
      lines.push(l);
    });

    expect(result.summary.skipped_row_changed).toBe(1);
    expect(result.summary.repointed).toBe(0);
    // 補償削除は新 key のみ。旧 key は決して含まない。
    expect(fake.deletes).toEqual([NEW_KEY]);
    expect(fake.deletes).not.toContain(OLD_KEY);
    expect(lines[0]).toMatchObject({
      photoId: "photo-1",
      outcome: "skipped_row_changed",
      oldKey: OLD_KEY,
      newKey: NEW_KEY,
      compensationDeleted: true,
    });
  });

  it("upload 例外 → failed(upload)。delete / repoint は発生しない", async () => {
    const fake = applyFake({ files: { [OLD_KEY]: buildJpegWithApp1() }, uploadThrows: true });
    const lines: ReturnType<typeof toRunLogLine>[] = [];
    const result = await runRetroStripApply(asyncRows([row()]), fake.ports, (l) => {
      lines.push(l);
    });
    expect(result.summary.failed).toBe(1);
    expect(fake.deletes).toEqual([]);
    expect(fake.repoints).toEqual([]);
    expect(lines[0]).toMatchObject({
      photoId: "photo-1",
      outcome: "failed",
      stage: "upload",
      errorName: "TypeError",
    });
  });

  it("repoint 例外 → failed(repoint)。新 key は記録のみ（DB 状態不明ゆえ補償削除しない）", async () => {
    const fake = applyFake({ files: { [OLD_KEY]: buildJpegWithApp1() }, repointThrows: true });
    const lines: ReturnType<typeof toRunLogLine>[] = [];
    const result = await runRetroStripApply(asyncRows([row()]), fake.ports, (l) => {
      lines.push(l);
    });
    expect(result.summary.failed).toBe(1);
    expect(fake.deletes).toEqual([]); // 補償削除しない（DB が更新済みか不明）
    expect(lines[0]).toMatchObject({
      photoId: "photo-1",
      outcome: "failed",
      stage: "repoint",
      errorName: "TypeError",
      newKey: NEW_KEY,
    });
  });

  it("複数行を sequential 集計し、run-log / 結果に fileName（PII）が漏れない", async () => {
    const clean = `field-survey/pins/${PIN}/photos/clean.jpg`;
    const fake = applyFake({
      files: { [OLD_KEY]: buildJpegWithApp1(), [clean]: buildCleanJpeg() },
      repointCount: 1,
    });
    const lines: unknown[] = [];
    const items = [
      row(), // repointed
      row({ id: "p2", fileUrl: `/uploads/${clean}` }), // unchanged（書き込みなし）
      row({ id: "p3", mimeType: "image/heic" }), // skipped_unsupported_mime
    ];
    const result = await runRetroStripApply(asyncRows(items), fake.ports, (l) => {
      lines.push(l);
    });
    expect(result.processed).toBe(3);
    expect(result.summary.repointed).toBe(1);
    expect(result.summary.unchanged).toBe(1);
    expect(result.summary.skipped_unsupported_mime).toBe(1);
    const serialized = JSON.stringify({ lines, result });
    expect(serialized).not.toContain("SENTINEL-PII-FILENAME");
  });
});

describe("applyExitCode", () => {
  const base = emptyOutcomeSummary();
  it("clean（failed/skipped_row_changed なし）→ 0", () => {
    expect(applyExitCode({ ...base, repointed: 5, unchanged: 3 })).toBe(0);
  });
  it("failed>0 → 1", () => {
    expect(applyExitCode({ ...base, repointed: 5, failed: 1 })).toBe(1);
  });
  it("skipped_row_changed>0 かつ failed=0 → 2（再実行推奨）", () => {
    expect(applyExitCode({ ...base, repointed: 5, skipped_row_changed: 2 })).toBe(2);
  });
  it("failed と skipped_row_changed が同時 → 1（致命を優先）", () => {
    expect(applyExitCode({ ...base, failed: 1, skipped_row_changed: 1 })).toBe(1);
  });
  it("expected skip（unsupported/malformed/unmappable/missing）のみ → 0", () => {
    expect(
      applyExitCode({
        ...base,
        skipped_unsupported_mime: 3,
        skipped_malformed: 1,
        skipped_unmappable_url: 2,
        skipped_missing_bytes: 1,
      }),
    ).toBe(0);
  });
});

describe("toRunLogLine（apply outcome）", () => {
  it("repointed は oldKey/newKey/bytes + (非null時)oldThumbnailKey。newFileUrl/newThumbnailUrl は持たない", () => {
    const line = toRunLogLine({
      outcome: "repointed",
      photoId: "x",
      oldKey: OLD_KEY,
      oldThumbnailKey: "field-survey/thumbs/old-t.jpg",
      newKey: NEW_KEY,
      newFileUrl: `/uploads/${NEW_KEY}`,
      newThumbnailUrl: "/uploads/field-survey/thumbs/new-t.jpg",
      bytesBefore: 100,
      bytesAfter: 60,
    });
    expect(line).toEqual({
      photoId: "x",
      outcome: "repointed",
      oldKey: OLD_KEY,
      oldThumbnailKey: "field-survey/thumbs/old-t.jpg",
      newKey: NEW_KEY,
      bytesBefore: 100,
      bytesAfter: 60,
    });
    const json = JSON.stringify(line);
    expect(json).not.toContain("newFileUrl");
    expect(json).not.toContain("newThumbnailUrl");
  });

  it("repointed で oldThumbnailKey=null のときは oldThumbnailKey を省略する", () => {
    const line = toRunLogLine({
      outcome: "repointed",
      photoId: "x",
      oldKey: OLD_KEY,
      oldThumbnailKey: null,
      newKey: NEW_KEY,
      newFileUrl: `/uploads/${NEW_KEY}`,
      newThumbnailUrl: null,
      bytesBefore: 100,
      bytesAfter: 60,
    });
    expect(line).not.toHaveProperty("oldThumbnailKey");
    expect(line).toMatchObject({ outcome: "repointed", oldKey: OLD_KEY, newKey: NEW_KEY });
  });

  it("skipped_row_changed は oldKey/newKey/compensationDeleted のみ", () => {
    expect(
      toRunLogLine({
        outcome: "skipped_row_changed",
        photoId: "x",
        oldKey: OLD_KEY,
        newKey: NEW_KEY,
        compensationDeleted: false,
      }),
    ).toEqual({
      photoId: "x",
      outcome: "skipped_row_changed",
      oldKey: OLD_KEY,
      newKey: NEW_KEY,
      compensationDeleted: false,
    });
  });

  it("failed(apply・newKey/compensationDeleted 付き) は stage/errorName/newKey/compensationDeleted を含む", () => {
    expect(
      toRunLogLine({
        outcome: "failed",
        photoId: "x",
        stage: "upload",
        errorName: "NonCanonicalUploadResultKey",
        newKey: NEW_KEY,
        compensationDeleted: true,
      }),
    ).toEqual({
      photoId: "x",
      outcome: "failed",
      stage: "upload",
      errorName: "NonCanonicalUploadResultKey",
      newKey: NEW_KEY,
      compensationDeleted: true,
    });
  });
});

// ---------------------------------------------------------------
// source assertion（dry-run の no-write 維持 + apply 配線のロック）
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

  it("lib は prisma / storage 実体 / next を import しない（DI を維持）", () => {
    // apply 配線（makeApplyPorts / makeUpdateManyRepointPhoto）も注入のみで、
    // getStorage / prisma を import しない（実体注入は wrapper が担う）。
    expect(libSrc).not.toContain("@/lib/prisma");
    expect(libSrc).not.toContain("generated/prisma");
    expect(libSrc).not.toContain("getStorage");
    expect(libSrc).not.toContain('from "next');
  });

  it("runner（dry-run / apply 共有）は結果配列を保持せず outcome を per-row 集計する（streaming）", () => {
    // 全件処理でヒープが行数比例で増えないこと（buffered-then-summarize の不再導入）。
    expect(libSrc).toContain("summary[result.outcome] += 1");
    expect(libSrc).not.toContain("summarizeRetroStripResults");
  });

  it("wrapper の dry-run は no-write（makeDryRunPorts の throw スタブ）を維持する", () => {
    // dry-run の「書き込みが起きない」本質保証は makeDryRunPorts の throw スタブ +
    // processRetroStripRow(mode:"dry-run") の早期 return（runtime テストでロック済み）。
    expect(scriptSrc).toContain("makeDryRunPorts");
  });

  it("wrapper の apply repoint は lib の makeUpdateManyRepointPhoto を経由する（updateMany shape は lib で型固定・テスト済）", () => {
    // 注: textual grep は best-effort。本質保証は makeUpdateManyRepointPhoto の型 +
    // runtime テスト（where{id,fileUrl} / data に mimeType 無し / .count 返却）。
    expect(scriptSrc).toContain("makeApplyPorts");
    expect(scriptSrc).toContain("makeUpdateManyRepointPhoto");
    // wrapper は updateMany の data オブジェクトを手書きしない（shape を lib に集約）。
    // data リテラル固有の fileSize は wrapper（SELECT_ROW に fileSize 無し）に現れない。
    expect(scriptSrc).not.toContain("fileSize");
    // 単一行 update（楽観ガード無し）は使わない（楽観ガード付き updateMany のみ）。
    expect(scriptSrc).not.toContain(".update(");
    // 新規行作成はしない。
    expect(scriptSrc).not.toContain(".create(");
  });

  it("wrapper は旧 key の削除導線を持たない（cleanup は PR-R2c・別承認）", () => {
    // 旧 key / 旧 thumbnail key の削除は本 PR の範囲外。core は新 key 補償削除にのみ
    // storage.delete を使う（core 側 source assertion でロック済み）。wrapper が oldKey /
    // oldThumbnailKey を参照していたら旧 key 操作の混入を疑うべき。
    expect(scriptSrc).not.toContain("oldKey");
    expect(scriptSrc).not.toContain("oldThumbnailKey");
  });

  it("wrapper は parse を lib に委譲し、prisma READ（findMany）/ storage read を使う", () => {
    expect(scriptSrc).toContain("parseRetroStripCliArgs");
    expect(scriptSrc).toContain("findMany");
    expect(scriptSrc).toContain("storage.read(");
  });
});
