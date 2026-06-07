/**
 * 遡及 EXIF/GPS strip batch core（retro-exif-strip.ts・PR-R1）の単体テスト。
 *
 * fixture ポリシー（field-survey-exif-strip.test.ts と同方針）:
 *   - 実画像ファイルは一切追加しない。全 fixture はコード内合成バイト列のみ。
 *   - 実座標・実個人情報は使わない。fileName はセンチネル文字列で
 *     「結果 record に漏れないこと」の検索キーを兼ねる。
 *   - storage / DB は in-memory fake（DI ports）のみ。本番 adapter / prisma は
 *     import すらしない。
 *
 * ロックする仕様:
 *   - 方式 = 新 key upload + 楽観ガード付き repoint（in-place 上書きをしない）
 *   - 旧 key / 旧 thumbnail key はどの outcome でも削除しない（rollback 窓保持）
 *   - storage.delete は「repoint ガード負け時の新 key 補償削除」の 1 箇所のみ
 *   - HEIC/HEIF = read 前 skip / malformed = skip（削除・上書きしない）
 *   - dry-run は upload / repoint / delete を一切呼ばない
 *   - changed=false（既に clean）は書き込みなしの unchanged（再実行冪等）
 *   - 新 key 形式は route と同一 `field-survey/pins/{pinId}/photos/{uuid}.{ext}`
 *   - 結果 record に fileName を含めない（非 PII 規律）
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  processRetroStripRow,
  summarizeRetroStripResults,
  RETRO_STRIP_OUTCOMES,
  type RetroStripPorts,
  type RetroStripRepointUpdate,
  type RetroStripRowInput,
  type RetroStripRowResult,
} from "@/lib/field-survey/retro-exif-strip";

// ---------------------------------------------------------------
// 合成バイト fixture（実画像・実座標なし）
// ---------------------------------------------------------------

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

/** 長さフィールド付き JPEG segment を組み立てる。 */
function jpegSegment(marker: number, payload: Buffer): Buffer {
  const len = payload.length + 2;
  return Buffer.concat([
    Buffer.from([0xff, marker, (len >> 8) & 0xff, len & 0xff]),
    payload,
  ]);
}

/** SOS segment + entropy data + EOI（strip は SOS 以降を無検証で温存する）。 */
const SOS_TAIL = Buffer.concat([
  Buffer.from([0xff, 0xda, 0x00, 0x04, 0x01, 0x02]),
  Buffer.from([0xab, 0xcd, 0x5a, 0x3c]),
  EOI,
]);

/** APP1（Exif ヘッダ + 解釈不能 TIFF）持ち JPEG。strip で APP1 が drop され縮む。 */
function buildJpegWithApp1(): Buffer {
  const app1Payload = Buffer.concat([
    Buffer.from("Exif\0\0", "latin1"),
    Buffer.from("XXNOT-A-TIFF-JUNK-METADATA", "latin1"),
  ]);
  return Buffer.concat([
    SOI,
    jpegSegment(0xe1, app1Payload),
    jpegSegment(0xe0, Buffer.from("JFIF\0", "latin1")),
    SOS_TAIL,
  ]);
}

/** APP1 を持たない clean JPEG。strip は changed=false で入力参照を返す。 */
function buildCleanJpeg(): Buffer {
  return Buffer.concat([
    SOI,
    jpegSegment(0xe0, Buffer.from("JFIF\0", "latin1")),
    SOS_TAIL,
  ]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG chunk（CRC は strip が検証しないため zero 埋め）。 */
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
}

/** eXIf chunk 持ち PNG。strip で eXIf が drop され縮む。 */
function buildPngWithExif(): Buffer {
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", Buffer.alloc(13)),
    pngChunk("eXIf", Buffer.from([0x01, 0x02, 0x03])),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** RIFF chunk（奇数長は 1 byte pad）。 */
function webpChunk(fourcc: string, data: Buffer): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(data.length, 0);
  const pad = data.length % 2 === 1 ? Buffer.from([0x00]) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from(fourcc, "latin1"), size, data, pad]);
}

/** EXIF chunk 持ち WebP。strip で EXIF chunk が drop され縮む。 */
function buildWebpWithExif(): Buffer {
  const body = Buffer.concat([
    webpChunk("VP8 ", Buffer.from([0x10, 0x20, 0x30, 0x40])),
    webpChunk("EXIF", Buffer.from([0x99, 0x88])),
  ]);
  const riffSize = Buffer.alloc(4);
  riffSize.writeUInt32LE(4 + body.length, 0); // "WEBP" + body（= 全長 - 8）
  return Buffer.concat([
    Buffer.from("RIFF", "latin1"),
    riffSize,
    Buffer.from("WEBP", "latin1"),
    body,
  ]);
}

/** JPEG として構造不正なバイト列（SOI 不在）。 */
const MALFORMED_BYTES = Buffer.from("not-a-jpeg-at-all", "latin1");

// ---------------------------------------------------------------
// 行 fixture / fake ports
// ---------------------------------------------------------------

const PIN_ID = "11111111-1111-4111-8111-111111111111";
const PHOTO_ID = "22222222-2222-4222-8222-222222222222";
const FIXED_UUID = "33333333-3333-4333-8333-333333333333";

const OLD_KEY = `field-survey/pins/${PIN_ID}/photos/old-photo.jpg`;
const OLD_FILE_URL = `/uploads/${OLD_KEY}`;
const EXPECTED_NEW_KEY = `field-survey/pins/${PIN_ID}/photos/${FIXED_UUID}.jpg`;

/** 結果 record への漏洩検査キーを兼ねるセンチネル fileName（実在しない名前）。 */
const SENTINEL_FILE_NAME = "SENTINEL-ORIGINAL-FILENAME.jpg";

function makeRow(overrides: Partial<RetroStripRowInput> = {}): RetroStripRowInput {
  return {
    id: PHOTO_ID,
    pinId: PIN_ID,
    fileUrl: OLD_FILE_URL,
    thumbnailUrl: null,
    fileName: SENTINEL_FILE_NAME,
    mimeType: "image/jpeg",
    ...overrides,
  };
}

interface FakeOptions {
  /** key → bytes。未登録 key の read は null（missing 扱い）。 */
  files?: Record<string, Buffer>;
  readThrows?: boolean;
  uploadThrows?: boolean;
  /** upload 返却値の上書き（backend による key 改変・thumbnail 返却の再現）。 */
  uploadResult?: { key?: string; thumbnailUrl?: string };
  /** repointPhoto の返却 count（既定 1）。 */
  repointCount?: number;
  repointThrows?: boolean;
  deleteThrows?: boolean;
}

interface FakeCalls {
  read: string[];
  upload: { key: string; mimeType: string; fileName: string; size: number }[];
  delete: string[];
  repoint: RetroStripRepointUpdate[];
}

function createFakes(options: FakeOptions = {}) {
  const calls: FakeCalls = { read: [], upload: [], delete: [], repoint: [] };
  const ports: RetroStripPorts = {
    storage: {
      async read(key) {
        calls.read.push(key);
        if (options.readThrows) throw new TypeError("read failure");
        const body = options.files?.[key];
        if (!body) return null;
        return { body, contentType: "application/octet-stream", size: body.length };
      },
      async upload(file, uploadOptions) {
        calls.upload.push({
          key: uploadOptions.key,
          mimeType: uploadOptions.mimeType,
          fileName: uploadOptions.fileName,
          size: file.length,
        });
        if (options.uploadThrows) throw new RangeError("upload failure");
        const key = options.uploadResult?.key ?? uploadOptions.key;
        return {
          url: `/uploads/${key}`,
          key,
          ...(options.uploadResult?.thumbnailUrl !== undefined
            ? { thumbnailUrl: options.uploadResult.thumbnailUrl }
            : {}),
        };
      },
      async delete(key) {
        calls.delete.push(key);
        if (options.deleteThrows) throw new Error("delete failure");
      },
    },
    async repointPhoto(update) {
      calls.repoint.push(update);
      if (options.repointThrows) throw new EvalError("repoint failure");
      return options.repointCount ?? 1;
    },
    generateUuid: () => FIXED_UUID,
  };
  return { ports, calls };
}

function expectNoWrites(calls: FakeCalls): void {
  expect(calls.upload).toHaveLength(0);
  expect(calls.repoint).toHaveLength(0);
  expect(calls.delete).toHaveLength(0);
}

// ---------------------------------------------------------------
// 分類（書き込みなし系）
// ---------------------------------------------------------------

describe("processRetroStripRow: 分類（書き込みなし）", () => {
  it.each([
    ["絶対 URL", "https://example.com/uploads/a.jpg"],
    ["data URL", "data:image/jpeg;base64,AAAA"],
    ["/uploads/ 以外", "/files/a.jpg"],
    ["空白のみ", "   "],
  ])(
    "fileUrl から key を復元できない行（%s）は skipped_unmappable_url・storage に一切触れない",
    async (_label, fileUrl) => {
      const { ports, calls } = createFakes();
      const result = await processRetroStripRow(
        makeRow({ fileUrl }),
        ports,
        { mode: "apply" },
      );
      expect(result).toEqual({
        outcome: "skipped_unmappable_url",
        photoId: PHOTO_ID,
      });
      expect(calls.read).toHaveLength(0);
      expectNoWrites(calls);
    },
  );

  it.each(["image/heic", "image/heif", "application/pdf"])(
    "未対応 MIME (%s) は read 前に skipped_unsupported_mime（変換も読込もしない）",
    async (mimeType) => {
      const { ports, calls } = createFakes({
        files: { [OLD_KEY]: buildJpegWithApp1() },
      });
      const result = await processRetroStripRow(
        makeRow({ mimeType }),
        ports,
        { mode: "apply" },
      );
      expect(result).toEqual({
        outcome: "skipped_unsupported_mime",
        photoId: PHOTO_ID,
        mimeType,
      });
      expect(calls.read).toHaveLength(0);
      expectNoWrites(calls);
    },
  );

  it("MIME 判定は大文字小文字を区別しない（IMAGE/JPEG は jpeg として処理される）", async () => {
    const { ports, calls } = createFakes({
      files: { [OLD_KEY]: buildCleanJpeg() },
    });
    const result = await processRetroStripRow(
      makeRow({ mimeType: "IMAGE/JPEG" }),
      ports,
      { mode: "apply" },
    );
    expect(result).toEqual({
      outcome: "unchanged",
      photoId: PHOTO_ID,
      oldKey: OLD_KEY,
    });
    expect(calls.read).toEqual([OLD_KEY]);
  });

  it("storage 実体なし（read=null）は skipped_missing_bytes・書き込みなし", async () => {
    const { ports, calls } = createFakes({ files: {} });
    const result = await processRetroStripRow(makeRow(), ports, { mode: "apply" });
    expect(result).toEqual({
      outcome: "skipped_missing_bytes",
      photoId: PHOTO_ID,
      oldKey: OLD_KEY,
    });
    expectNoWrites(calls);
  });

  it("構造不正バイト列は skipped_malformed・原本に書き込まない", async () => {
    const { ports, calls } = createFakes({
      files: { [OLD_KEY]: MALFORMED_BYTES },
    });
    const result = await processRetroStripRow(makeRow(), ports, { mode: "apply" });
    expect(result).toEqual({
      outcome: "skipped_malformed",
      photoId: PHOTO_ID,
      oldKey: OLD_KEY,
    });
    expectNoWrites(calls);
  });

  it("DB mimeType と実バイトの不一致（jpeg 申告の PNG バイト）は skipped_malformed に倒す", async () => {
    const { ports, calls } = createFakes({
      files: { [OLD_KEY]: buildPngWithExif() },
    });
    const result = await processRetroStripRow(
      makeRow({ mimeType: "image/jpeg" }),
      ports,
      { mode: "apply" },
    );
    expect(result).toEqual({
      outcome: "skipped_malformed",
      photoId: PHOTO_ID,
      oldKey: OLD_KEY,
    });
    expectNoWrites(calls);
  });
});

// ---------------------------------------------------------------
// 冪等 / dry-run
// ---------------------------------------------------------------

describe("processRetroStripRow: 冪等 / dry-run", () => {
  it("既に clean（changed=false）は unchanged・書き込みゼロ（再実行冪等の根拠）", async () => {
    const { ports, calls } = createFakes({
      files: { [OLD_KEY]: buildCleanJpeg() },
    });
    const result = await processRetroStripRow(makeRow(), ports, { mode: "apply" });
    expect(result).toEqual({
      outcome: "unchanged",
      photoId: PHOTO_ID,
      oldKey: OLD_KEY,
    });
    expectNoWrites(calls);
  });

  it("dry-run は would_strip を返し upload / repoint / delete を一切呼ばない", async () => {
    const fixture = buildJpegWithApp1();
    const { ports, calls } = createFakes({ files: { [OLD_KEY]: fixture } });
    const result = await processRetroStripRow(makeRow(), ports, { mode: "dry-run" });
    expect(result.outcome).toBe("would_strip");
    if (result.outcome !== "would_strip") throw new Error("unreachable");
    expect(result.photoId).toBe(PHOTO_ID);
    expect(result.oldKey).toBe(OLD_KEY);
    expect(result.bytesBefore).toBe(fixture.length);
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
    expectNoWrites(calls);
  });

  it("dry-run でも clean ファイルは unchanged（would_strip にしない）", async () => {
    const { ports, calls } = createFakes({
      files: { [OLD_KEY]: buildCleanJpeg() },
    });
    const result = await processRetroStripRow(makeRow(), ports, { mode: "dry-run" });
    expect(result.outcome).toBe("unchanged");
    expectNoWrites(calls);
  });
});

// ---------------------------------------------------------------
// apply 正常系（新 key upload + repoint）
// ---------------------------------------------------------------

describe("processRetroStripRow: apply 正常系", () => {
  it("JPEG: 新 key（route と同形式）に strip 済みバイトを upload し楽観ガード付きで repoint する", async () => {
    const fixture = buildJpegWithApp1();
    const { ports, calls } = createFakes({ files: { [OLD_KEY]: fixture } });
    const result = await processRetroStripRow(makeRow(), ports, { mode: "apply" });

    expect(result.outcome).toBe("repointed");
    if (result.outcome !== "repointed") throw new Error("unreachable");

    // upload: 新 key 形式・MIME / fileName 透過・strip 済みサイズ
    expect(calls.upload).toHaveLength(1);
    expect(calls.upload[0].key).toBe(EXPECTED_NEW_KEY);
    expect(calls.upload[0].mimeType).toBe("image/jpeg");
    expect(calls.upload[0].fileName).toBe(SENTINEL_FILE_NAME);
    expect(calls.upload[0].size).toBeLessThan(fixture.length);

    // repoint: 楽観ガード（expectedFileUrl=読み取り時点の旧 URL）+ strip 後 fileSize
    expect(calls.repoint).toHaveLength(1);
    expect(calls.repoint[0]).toEqual({
      id: PHOTO_ID,
      expectedFileUrl: OLD_FILE_URL,
      newFileUrl: `/uploads/${EXPECTED_NEW_KEY}`,
      newThumbnailUrl: null,
      newFileSize: calls.upload[0].size,
    });

    // 結果 record
    expect(result.oldKey).toBe(OLD_KEY);
    expect(result.oldThumbnailKey).toBeNull();
    expect(result.newKey).toBe(EXPECTED_NEW_KEY);
    expect(result.newFileUrl).toBe(`/uploads/${EXPECTED_NEW_KEY}`);
    expect(result.bytesBefore).toBe(fixture.length);
    expect(result.bytesAfter).toBe(calls.upload[0].size);

    // 旧 key は削除しない（rollback 窓）
    expect(calls.delete).toHaveLength(0);
  });

  it("generateUuid 未注入時は UUID 形式の新 key を生成する（randomUUID 既定）", async () => {
    const { ports, calls } = createFakes({
      files: { [OLD_KEY]: buildJpegWithApp1() },
    });
    delete ports.generateUuid;
    const result = await processRetroStripRow(makeRow(), ports, { mode: "apply" });
    expect(result.outcome).toBe("repointed");
    expect(calls.upload[0].key).toMatch(
      new RegExp(
        `^field-survey/pins/${PIN_ID}/photos/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.jpg$`,
      ),
    );
  });

  it("PNG: 拡張子 .png の新 key で repoint する", async () => {
    const pngKey = `field-survey/pins/${PIN_ID}/photos/old-photo.png`;
    const { ports, calls } = createFakes({
      files: { [pngKey]: buildPngWithExif() },
    });
    const result = await processRetroStripRow(
      makeRow({ fileUrl: `/uploads/${pngKey}`, mimeType: "image/png" }),
      ports,
      { mode: "apply" },
    );
    expect(result.outcome).toBe("repointed");
    expect(calls.upload[0].key).toBe(
      `field-survey/pins/${PIN_ID}/photos/${FIXED_UUID}.png`,
    );
  });

  it("WebP: 拡張子 .webp の新 key で repoint する（EXIF chunk drop で縮む）", async () => {
    const webpKey = `field-survey/pins/${PIN_ID}/photos/old-photo.webp`;
    const fixture = buildWebpWithExif();
    const { ports, calls } = createFakes({
      files: { [webpKey]: fixture },
    });
    const result = await processRetroStripRow(
      makeRow({ fileUrl: `/uploads/${webpKey}`, mimeType: "image/webp" }),
      ports,
      { mode: "apply" },
    );
    expect(result.outcome).toBe("repointed");
    if (result.outcome !== "repointed") throw new Error("unreachable");
    expect(calls.upload[0].key).toBe(
      `field-survey/pins/${PIN_ID}/photos/${FIXED_UUID}.webp`,
    );
    expect(result.bytesAfter).toBeLessThan(fixture.length);
  });

  it("backend が key を改変して返した場合は返却 key を採用して repoint する（route と同方針）", async () => {
    const renamedKey = `field-survey/pins/${PIN_ID}/photos/renamed-by-backend.jpg`;
    const { ports, calls } = createFakes({
      files: { [OLD_KEY]: buildJpegWithApp1() },
      uploadResult: { key: renamedKey },
    });
    const result = await processRetroStripRow(makeRow(), ports, { mode: "apply" });
    expect(result.outcome).toBe("repointed");
    if (result.outcome !== "repointed") throw new Error("unreachable");
    expect(result.newKey).toBe(renamedKey);
    expect(result.newFileUrl).toBe(`/uploads/${renamedKey}`);
    expect(calls.repoint[0].newFileUrl).toBe(`/uploads/${renamedKey}`);
    expect(calls.repoint[0].expectedFileUrl).toBe(OLD_FILE_URL);
  });
});

// ---------------------------------------------------------------
// thumbnail
// ---------------------------------------------------------------

describe("processRetroStripRow: thumbnail", () => {
  it("upload が /uploads 相対 thumbnail を返した場合は保持して repoint する", async () => {
    const thumb = `/uploads/field-survey/pins/${PIN_ID}/photos/thumb-new.jpg`;
    const { ports, calls } = createFakes({
      files: { [OLD_KEY]: buildJpegWithApp1() },
      uploadResult: { thumbnailUrl: thumb },
    });
    const result = await processRetroStripRow(makeRow(), ports, { mode: "apply" });
    expect(result.outcome).toBe("repointed");
    if (result.outcome !== "repointed") throw new Error("unreachable");
    expect(result.newThumbnailUrl).toBe(thumb);
    expect(calls.repoint[0].newThumbnailUrl).toBe(thumb);
  });

  it("絶対 URL の /uploads thumbnail は proxy 相対に正規化して保持する（route と同セマンティクス）", async () => {
    const { ports, calls } = createFakes({
      files: { [OLD_KEY]: buildJpegWithApp1() },
      uploadResult: {
        thumbnailUrl: "http://localhost:3000/uploads/thumbs/t1.jpg",
      },
    });
    const result = await processRetroStripRow(makeRow(), ports, { mode: "apply" });
    expect(result.outcome).toBe("repointed");
    if (result.outcome !== "repointed") throw new Error("unreachable");
    expect(result.newThumbnailUrl).toBe("/uploads/thumbs/t1.jpg");
    expect(calls.repoint[0].newThumbnailUrl).toBe("/uploads/thumbs/t1.jpg");
  });

  it("外部 host の thumbnail は保存せず null に倒す", async () => {
    const { ports, calls } = createFakes({
      files: { [OLD_KEY]: buildJpegWithApp1() },
      uploadResult: { thumbnailUrl: "https://cdn.example.com/t1.jpg" },
    });
    const result = await processRetroStripRow(makeRow(), ports, { mode: "apply" });
    expect(result.outcome).toBe("repointed");
    if (result.outcome !== "repointed") throw new Error("unreachable");
    expect(result.newThumbnailUrl).toBeNull();
    expect(calls.repoint[0].newThumbnailUrl).toBeNull();
  });

  it("旧 thumbnail がある行: 新 thumbnail なしなら null へ repoint し、旧 thumbnail key は記録のみ（削除しない）", async () => {
    const oldThumbKey = "field-survey/thumbs/old-thumb.jpg";
    const { ports, calls } = createFakes({
      files: { [OLD_KEY]: buildJpegWithApp1() },
    });
    const result = await processRetroStripRow(
      makeRow({ thumbnailUrl: `/uploads/${oldThumbKey}` }),
      ports,
      { mode: "apply" },
    );
    expect(result.outcome).toBe("repointed");
    if (result.outcome !== "repointed") throw new Error("unreachable");
    expect(result.oldThumbnailKey).toBe(oldThumbKey);
    expect(result.newThumbnailUrl).toBeNull();
    expect(calls.repoint[0].newThumbnailUrl).toBeNull();
    expect(calls.delete).toHaveLength(0);
  });
});

// ---------------------------------------------------------------
// race / 失敗系
// ---------------------------------------------------------------

describe("processRetroStripRow: race / 失敗系", () => {
  it("楽観ガード負け（count=0）: 新 key のみ補償削除し skipped_row_changed（旧 key 不可侵）", async () => {
    const { ports, calls } = createFakes({
      files: { [OLD_KEY]: buildJpegWithApp1() },
      repointCount: 0,
    });
    const result = await processRetroStripRow(makeRow(), ports, { mode: "apply" });
    expect(result).toEqual({
      outcome: "skipped_row_changed",
      photoId: PHOTO_ID,
      oldKey: OLD_KEY,
      newKey: EXPECTED_NEW_KEY,
      compensationDeleted: true,
    });
    expect(calls.delete).toEqual([EXPECTED_NEW_KEY]);
    expect(calls.delete).not.toContain(OLD_KEY);
  });

  it("補償削除が throw しても swallow し compensationDeleted=false で返す", async () => {
    const { ports } = createFakes({
      files: { [OLD_KEY]: buildJpegWithApp1() },
      repointCount: 0,
      deleteThrows: true,
    });
    const result = await processRetroStripRow(makeRow(), ports, { mode: "apply" });
    expect(result).toMatchObject({
      outcome: "skipped_row_changed",
      compensationDeleted: false,
    });
  });

  it("read throw は failed(stage=read)・エラー名のみ記録", async () => {
    const { ports, calls } = createFakes({ readThrows: true });
    const result = await processRetroStripRow(makeRow(), ports, { mode: "apply" });
    expect(result).toEqual({
      outcome: "failed",
      photoId: PHOTO_ID,
      stage: "read",
      errorName: "TypeError",
    });
    expectNoWrites(calls);
  });

  it("upload throw は failed(stage=upload)・repoint へ進まない", async () => {
    const { ports, calls } = createFakes({
      files: { [OLD_KEY]: buildJpegWithApp1() },
      uploadThrows: true,
    });
    const result = await processRetroStripRow(makeRow(), ports, { mode: "apply" });
    expect(result).toEqual({
      outcome: "failed",
      photoId: PHOTO_ID,
      stage: "upload",
      errorName: "RangeError",
    });
    expect(calls.repoint).toHaveLength(0);
    expect(calls.delete).toHaveLength(0);
  });

  it("repoint throw は failed(stage=repoint)・DB 状態不明のため補償削除せず新 key を記録する", async () => {
    const { ports, calls } = createFakes({
      files: { [OLD_KEY]: buildJpegWithApp1() },
      repointThrows: true,
    });
    const result = await processRetroStripRow(makeRow(), ports, { mode: "apply" });
    expect(result).toEqual({
      outcome: "failed",
      photoId: PHOTO_ID,
      stage: "repoint",
      errorName: "EvalError",
      newKey: EXPECTED_NEW_KEY,
    });
    expect(calls.delete).toHaveLength(0);
  });

  // ── Codex P2: uploaded.key 自体が canonical でないと DB 保存 URL（正規化後）と
  //    storage 実体 key（非正規のまま）がズレる。canonical 検証で repoint を止める。

  it.each([
    ["traversal key", "../escape.jpg"],
    ["空 key", ""],
  ])(
    "backend 返却 key が proxy URL に変換できない（%s）なら failed(InvalidUploadResultKey)・repoint も delete もしない",
    async (_label, badKey) => {
      const { ports, calls } = createFakes({
        files: { [OLD_KEY]: buildJpegWithApp1() },
        uploadResult: { key: badKey },
      });
      const result = await processRetroStripRow(makeRow(), ports, { mode: "apply" });
      expect(result).toEqual({
        outcome: "failed",
        photoId: PHOTO_ID,
        stage: "upload",
        errorName: "InvalidUploadResultKey",
        newKey: badKey,
        compensationDeleted: false,
      });
      expect(calls.repoint).toHaveLength(0);
      // 危険な key（traversal/空）は delete にも渡さない（旧データ破壊を最優先で回避）
      expect(calls.delete).toHaveLength(0);
    },
  );

  it.each([
    ["backslash key", `field-survey\\pins\\${PIN_ID}\\photos\\x.jpg`],
    ["連続スラッシュ key", `field-survey//pins/${PIN_ID}/photos/x.jpg`],
    ["先頭スラッシュ key", `/field-survey/pins/${PIN_ID}/photos/x.jpg`],
  ])(
    "backend が非 canonical key（%s）を返したら failed(NonCanonical)・repoint せず DB を更新しない・旧 key 不可侵（adapter が弾く形なので delete も発行しない）",
    async (_label, nonCanonicalKey) => {
      const { ports, calls } = createFakes({
        files: { [OLD_KEY]: buildJpegWithApp1() },
        uploadResult: { key: nonCanonicalKey },
      });
      const result = await processRetroStripRow(makeRow(), ports, { mode: "apply" });
      expect(result).toEqual({
        outcome: "failed",
        photoId: PHOTO_ID,
        stage: "upload",
        errorName: "NonCanonicalUploadResultKey",
        newKey: nonCanonicalKey,
        compensationDeleted: false,
      });
      // DB（repoint）は新 URL へ更新されない
      expect(calls.repoint).toHaveLength(0);
      // 旧 key・非正規 key いずれも delete に渡さない（旧データ破壊回避を最優先）
      expect(calls.delete).toHaveLength(0);
    },
  );

  it("非 canonical だが構造的に有効な key（'?' 混入）は repoint せず、新 key のみ補償削除する（旧 key 不可侵）", async () => {
    // '?' は isValidStorageKey 的には有効だが proxy URL で truncate され key 導出がズレる。
    // この実体（新規 upload 分）だけは安全に補償削除できる（旧 key には触れない）。
    const queryKey = `field-survey/pins/${PIN_ID}/photos/x?y.jpg`;
    const { ports, calls } = createFakes({
      files: { [OLD_KEY]: buildJpegWithApp1() },
      uploadResult: { key: queryKey },
    });
    const result = await processRetroStripRow(makeRow(), ports, { mode: "apply" });
    expect(result).toEqual({
      outcome: "failed",
      photoId: PHOTO_ID,
      stage: "upload",
      errorName: "NonCanonicalUploadResultKey",
      newKey: queryKey,
      compensationDeleted: true,
    });
    expect(calls.repoint).toHaveLength(0);
    // 補償削除は新 key（backend が返した実体）のみ。旧 key には決して到達しない。
    expect(calls.delete).toEqual([queryKey]);
    expect(calls.delete).not.toContain(OLD_KEY);
  });

  it("非 canonical key の補償削除が throw しても swallow し compensationDeleted=false で返す（旧データ不変）", async () => {
    const queryKey = `field-survey/pins/${PIN_ID}/photos/x?y.jpg`;
    const { ports, calls } = createFakes({
      files: { [OLD_KEY]: buildJpegWithApp1() },
      uploadResult: { key: queryKey },
      deleteThrows: true,
    });
    const result = await processRetroStripRow(makeRow(), ports, { mode: "apply" });
    expect(result).toMatchObject({
      outcome: "failed",
      errorName: "NonCanonicalUploadResultKey",
      compensationDeleted: false,
    });
    expect(calls.repoint).toHaveLength(0);
    expect(calls.delete).not.toContain(OLD_KEY);
  });

  it("canonical key（旧 key と異なる正規 key）なら従来どおり成功する（回帰確認）", async () => {
    const canonicalKey = `field-survey/pins/${PIN_ID}/photos/fresh-canonical.jpg`;
    const { ports, calls } = createFakes({
      files: { [OLD_KEY]: buildJpegWithApp1() },
      uploadResult: { key: canonicalKey },
    });
    const result = await processRetroStripRow(makeRow(), ports, { mode: "apply" });
    expect(result.outcome).toBe("repointed");
    if (result.outcome !== "repointed") throw new Error("unreachable");
    expect(result.newKey).toBe(canonicalKey);
    expect(result.newFileUrl).toBe(`/uploads/${canonicalKey}`);
    expect(calls.repoint).toHaveLength(1);
    expect(calls.repoint[0].newFileUrl).toBe(`/uploads/${canonicalKey}`);
    expect(calls.delete).toHaveLength(0);
  });

  it.each([
    ["旧 key そのまま", OLD_KEY],
    ["正規化すると旧 key（leading slash 付き）", `/${OLD_KEY}`],
  ])(
    "backend が key を回転させず旧 key 相当（%s）を返したら failed（補償削除が旧実体に到達しない）",
    async (_label, echoedKey) => {
      const { ports, calls } = createFakes({
        files: { [OLD_KEY]: buildJpegWithApp1() },
        uploadResult: { key: echoedKey },
        // ガード負けでも起きるよう count=0 にし、「delete が呼ばれない」ことを強く確認
        repointCount: 0,
      });
      const result = await processRetroStripRow(makeRow(), ports, { mode: "apply" });
      expect(result).toEqual({
        outcome: "failed",
        photoId: PHOTO_ID,
        stage: "upload",
        errorName: "UploadKeyNotRotated",
        newKey: echoedKey,
      });
      expect(calls.repoint).toHaveLength(0);
      expect(calls.delete).toHaveLength(0);
    },
  );
});

// ---------------------------------------------------------------
// 規律（旧 key 不可侵 / 非 PII / 集計）
// ---------------------------------------------------------------

describe("retro-exif-strip: 規律", () => {
  it("全シナリオを通して旧 key / 旧 thumbnail key への delete は一度も発行されない", async () => {
    const oldThumbKey = "field-survey/thumbs/old-thumb.jpg";
    const scenarios: FakeOptions[] = [
      { files: { [OLD_KEY]: buildJpegWithApp1() } }, // repointed
      { files: { [OLD_KEY]: buildCleanJpeg() } }, // unchanged
      { files: { [OLD_KEY]: buildJpegWithApp1() }, repointCount: 0 }, // row_changed
      { files: { [OLD_KEY]: MALFORMED_BYTES } }, // malformed
      { files: {} }, // missing
      { files: { [OLD_KEY]: buildJpegWithApp1() }, uploadThrows: true }, // failed
      // non-canonical 返却 key（補償削除あり/なし）でも旧 key・旧 thumb は不可侵
      {
        files: { [OLD_KEY]: buildJpegWithApp1() },
        uploadResult: { key: `field-survey/pins/${PIN_ID}/photos/x?y.jpg` },
      }, // NonCanonical（補償削除 = 新 key のみ）
      {
        files: { [OLD_KEY]: buildJpegWithApp1() },
        uploadResult: { key: `field-survey\\pins\\${PIN_ID}\\x.jpg` },
      }, // NonCanonical（delete 非発行）
      {
        files: { [OLD_KEY]: buildJpegWithApp1() },
        uploadResult: { key: OLD_KEY },
        repointCount: 0,
      }, // UploadKeyNotRotated（delete 非発行）
    ];
    for (const options of scenarios) {
      const { ports, calls } = createFakes(options);
      await processRetroStripRow(
        makeRow({ thumbnailUrl: `/uploads/${oldThumbKey}` }),
        ports,
        { mode: "apply" },
      );
      expect(calls.delete).not.toContain(OLD_KEY);
      expect(calls.delete).not.toContain(oldThumbKey);
    }
  });

  it("結果 record に fileName（センチネル）が一切漏れない（非 PII 規律・全 outcome 網羅）", async () => {
    const scenarios: { options: FakeOptions; row?: Partial<RetroStripRowInput> }[] = [
      { options: { files: { [OLD_KEY]: buildJpegWithApp1() } } }, // repointed / would_strip
      { options: { files: { [OLD_KEY]: buildCleanJpeg() } } }, // unchanged
      { options: { files: { [OLD_KEY]: buildJpegWithApp1() }, repointCount: 0 } }, // row_changed
      { options: { files: { [OLD_KEY]: MALFORMED_BYTES } } }, // malformed
      { options: { files: {} } }, // missing
      { options: { files: { [OLD_KEY]: buildJpegWithApp1() }, uploadThrows: true } }, // failed(upload)
      { options: { files: { [OLD_KEY]: buildJpegWithApp1() }, repointThrows: true } }, // failed(repoint)
      { options: {}, row: { mimeType: "image/heic" } }, // skipped_unsupported_mime
      { options: {}, row: { fileUrl: "https://example.com/uploads/a.jpg" } }, // skipped_unmappable_url
    ];
    const results: RetroStripRowResult[] = [];
    for (const { options, row } of scenarios) {
      const { ports } = createFakes(options);
      results.push(
        await processRetroStripRow(makeRow(row), ports, { mode: "apply" }),
      );
      const { ports: dryPorts } = createFakes(options);
      results.push(
        await processRetroStripRow(makeRow(row), dryPorts, { mode: "dry-run" }),
      );
    }
    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain("SENTINEL-ORIGINAL-FILENAME");
  });

  it("summarizeRetroStripResults は全 outcome キーを 0 初期化した上で件数を集計する", async () => {
    const { ports } = createFakes({ files: { [OLD_KEY]: buildJpegWithApp1() } });
    const repointed = await processRetroStripRow(makeRow(), ports, {
      mode: "apply",
    });
    const { ports: cleanPorts } = createFakes({
      files: { [OLD_KEY]: buildCleanJpeg() },
    });
    const unchanged = await processRetroStripRow(makeRow(), cleanPorts, {
      mode: "apply",
    });

    const summary = summarizeRetroStripResults([repointed, unchanged, unchanged]);
    expect(Object.keys(summary).sort()).toEqual([...RETRO_STRIP_OUTCOMES].sort());
    expect(summary.repointed).toBe(1);
    expect(summary.unchanged).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.would_strip).toBe(0);
  });

  it("source assertion: lib は prisma / next / getStorage を import せず、既存 utility を再利用する", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/field-survey/retro-exif-strip.ts"),
      "utf8",
    );
    // 実 DB / 実 storage / Next runtime への直接依存を持たない（DI 専用）
    expect(src).not.toContain("@/lib/prisma");
    expect(src).not.toContain('from "next');
    expect(src).not.toContain("getStorage");
    // 既存 utility の再利用（独自再実装しない）
    expect(src).toContain("stripFieldSurveyPhotoMetadata");
    expect(src).toContain("extractStorageKeyFromUrl");
    expect(src).toContain("isValidStorageKey");
    // storage.delete の呼び出しは「補償削除」2 箇所のみ（cleanup 機能は持ち込まない）:
    //   ① 楽観ガード負け時の新 key 補償削除
    //   ② canonical 検証失敗時の非正規 新 key 補償削除（isValidStorageKey gate 付き）
    // いずれも対象は新 key のみ。旧 key を delete に渡す箇所は存在しない。
    expect(src.match(/storage\.delete\(/g)).toHaveLength(2);
    expect(src).not.toContain("storage.delete(oldKey)");
  });
});
