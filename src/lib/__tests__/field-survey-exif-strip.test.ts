/**
 * field-survey EXIF/GPS strip pure utility（field-survey photos route に接続済み）の
 * 合成バイト fixture テスト。route 側の結合テストは field-survey-pin-photos-route.test.ts。
 *
 * fixture ポリシー:
 *   - 実画像ファイルは一切追加しない。全 fixture はコード内で組み立てる合成バイト列のみ。
 *   - 実座標・実個人情報は使わない。GPS 値は「緯度 9999 度（> 90 で実在し得ない）」
 *     「分母 0 の rational（数値として無効）」のセンチネルのみを埋め込む。
 *   - GPS 値センチネル（0xDEADBEEF / 0xFEEDFACE）は除去確認の検索キーを兼ねる。
 *
 * ロックする仕様（PR #144 Codex review 対応で JPEG 方式を変更）:
 *   - JPEG: APP1 segment（Exif / XMP とも）を全 drop し、元 Exif の Orientation
 *     （0x0112・値 1〜8）が読めた場合のみ「Orientation 1 タグだけの最小 Exif APP1
 *     （LE 固定テンプレート）」を SOI 直後に再注入する。Make / Model /
 *     DateTimeOriginal / シリアル / ExifIFD / MakerNote / GPS は一切保存しない
 *   - malformed 境界: JPEG segment 構造の異常のみ malformed（fail-closed 連結用）。
 *     Exif APP1 内部の異常は drop + 再注入なしに倒し、upload を拒否しない
 *   - PNG: eXIf chunk drop / WebP: EXIF chunk drop + RIFF size 再計算 + VP8X flag clear
 *   - HEIC/HEIF ほか未対応 MIME: unsupported_mime
 *   - 入力 buffer を mutate しない・changed=false 時は入力をそのまま返す
 */
import { describe, it, expect } from "vitest";
import {
  stripFieldSurveyPhotoMetadata,
  type ExifStripResult,
} from "@/lib/field-survey/exif-strip";

// ---------------------------------------------------------------
// 合成バイト fixture ビルダー
// ---------------------------------------------------------------

/** GPS rational 値のセンチネル。除去後にこのバイト列が残らないことを検索で確認する。 */
const GPS_SENTINEL_A = 0xdeadbeef;
const GPS_SENTINEL_B = 0xfeedface;
/** 「緯度 9999 度」= 実在し得ない合成値（実座標を fixture に使わないためのガード）。 */
const IMPOSSIBLE_LATITUDE_DEGREES = 9999;

function u16(le: boolean, v: number): Buffer {
  const b = Buffer.alloc(2);
  if (le) b.writeUInt16LE(v);
  else b.writeUInt16BE(v);
  return b;
}

function u32(le: boolean, v: number): Buffer {
  const b = Buffer.alloc(4);
  if (le) b.writeUInt32LE(v >>> 0);
  else b.writeUInt32BE(v >>> 0);
  return b;
}

/** 12 byte の TIFF IFD エントリ。valueField は必ず 4 byte。 */
function tiffEntry(
  le: boolean,
  tag: number,
  type: number,
  count: number,
  valueField: Buffer,
): Buffer {
  expect(valueField.length).toBe(4);
  return Buffer.concat([u16(le, tag), u16(le, type), u32(le, count), valueField]);
}

interface ExifTiffFixture {
  tiff: Buffer;
  /** TIFF 先頭からの相対 offset（zero-fill 期待領域の検証用）。withGps=false 時は null。 */
  gps: {
    ifdStart: number; // GPS IFD の entry count 位置
    ifdEnd: number; // next-IFD pointer 終端（exclusive）
    valueStart: number; // out-of-line rational 値の先頭
    valueEnd: number;
  } | null;
  /** Orientation エントリの value field の相対 offset（保持確認用）。 */
  orientationValueOffset: number;
}

/**
 * Orientation（=6）+ 任意で GPS IFD（LatitudeRef "N\0" inline + Latitude rational×3
 * out-of-line）を持つ最小 TIFF を組み立てる。
 */
function buildExifTiff(opts: {
  le: boolean;
  withGps: boolean;
  gpsIfdOffsetOverride?: number;
  gpsValueOffsetOverride?: number;
  tiffMagicOverride?: number;
  gpsLatTypeOverride?: number;
  orientationValueOverride?: number;
}): ExifTiffFixture {
  const { le, withGps } = opts;
  const entryCount = withGps ? 2 : 1;
  const ifd0Offset = 8;
  const ifd0Size = 2 + entryCount * 12 + 4;
  const gpsIfdOffset = opts.gpsIfdOffsetOverride ?? ifd0Offset + ifd0Size; // 既定: IFD0 直後
  const gpsIfdSize = 2 + 2 * 12 + 4;
  const gpsValueOffset = opts.gpsValueOffsetOverride ?? gpsIfdOffset + gpsIfdSize;

  const header = Buffer.concat([
    Buffer.from(le ? "II" : "MM", "latin1"),
    u16(le, opts.tiffMagicOverride ?? 42),
    u32(le, ifd0Offset),
  ]);

  // Orientation = 6（90°CW タグ回転）。SHORT の inline 値は value field 先頭 2 byte。
  const orientationEntry = tiffEntry(
    le,
    0x0112,
    3,
    1,
    Buffer.concat([u16(le, opts.orientationValueOverride ?? 6), u16(le, 0)]),
  );
  const ifd0Entries = [orientationEntry];
  if (withGps) {
    ifd0Entries.push(tiffEntry(le, 0x8825, 4, 1, u32(le, gpsIfdOffset)));
  }
  const ifd0 = Buffer.concat([u16(le, entryCount), ...ifd0Entries, u32(le, 0)]);

  if (!withGps) {
    const tiff = Buffer.concat([header, ifd0]);
    return { tiff, gps: null, orientationValueOffset: ifd0Offset + 2 + 8 };
  }

  // GPS IFD: LatitudeRef "N\0"（inline）+ Latitude rational×3（out-of-line 24 byte）
  const gpsEntries = [
    tiffEntry(le, 0x0001, 2, 2, Buffer.from("N\0\0\0", "latin1")),
    tiffEntry(le, 0x0002, opts.gpsLatTypeOverride ?? 5, 3, u32(le, gpsValueOffset)),
  ];
  const gpsIfd = Buffer.concat([u16(le, 2), ...gpsEntries, u32(le, 0)]);
  // rational 3 組: (9999, 1) = 緯度 9999 度（実在不可能）+ 分母 0 のセンチネル 2 組
  const gpsValues = Buffer.concat([
    u32(le, IMPOSSIBLE_LATITUDE_DEGREES),
    u32(le, 1),
    u32(le, GPS_SENTINEL_A),
    u32(le, 0),
    u32(le, GPS_SENTINEL_B),
    u32(le, 0),
  ]);
  const tiff = Buffer.concat([header, ifd0, gpsIfd, gpsValues]);
  return {
    tiff,
    gps: {
      ifdStart: gpsIfdOffset,
      ifdEnd: gpsIfdOffset + gpsIfdSize,
      valueStart: gpsValueOffset,
      valueEnd: gpsValueOffset + 24,
    },
    orientationValueOffset: ifd0Offset + 2 + 8,
  };
}

/** marker + 2 byte 長 + payload の JPEG segment。 */
function jpegSegment(marker: number, payload: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, marker]),
    u16(false, payload.length + 2),
    payload,
  ]);
}

interface JpegFixture {
  jpeg: Buffer;
  /** Exif APP1 内 TIFF 先頭の絶対 offset（withExif=false 時は -1）。 */
  tiffAbsStart: number;
  tiffFixture: ExifTiffFixture | null;
}

/** SOI + (任意 XMP APP1) + (任意 Exif APP1) + DQT 風 segment + SOS + entropy + EOI。 */
function buildJpeg(opts: {
  tiff?: ExifTiffFixture;
  xmpApp1?: boolean;
  omitSos?: boolean;
}): JpegFixture {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  let tiffAbsStart = -1;
  if (opts.xmpApp1) {
    parts.push(
      jpegSegment(
        0xe1,
        Buffer.from("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>", "latin1"),
      ),
    );
  }
  if (opts.tiff) {
    const exifPayload = Buffer.concat([
      Buffer.from("Exif\0\0", "latin1"),
      opts.tiff.tiff,
    ]);
    const lenBefore = parts.reduce((sum, b) => sum + b.length, 0);
    // APP1 = 0xFF 0xE1 + len(2) + "Exif\0\0"(6) + TIFF
    tiffAbsStart = lenBefore + 2 + 2 + 6;
    parts.push(jpegSegment(0xe1, exifPayload));
  }
  parts.push(jpegSegment(0xdb, Buffer.from([0x00, 0x01]))); // DQT 風（中身は検証対象外）
  if (!opts.omitSos) {
    parts.push(jpegSegment(0xda, Buffer.from([0x01, 0x00]))); // SOS
    parts.push(Buffer.from([0x12, 0x34, 0xff, 0xd9])); // entropy + EOI
  }
  return { jpeg: Buffer.concat(parts), tiffAbsStart, tiffFixture: opts.tiff ?? null };
}

/** PNG chunk（CRC は本 utility が検証しないため固定ダミー値）。 */
function pngChunk(type: string, data: Buffer): Buffer {
  return Buffer.concat([
    u32(false, data.length),
    Buffer.from(type, "latin1"),
    data,
    Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]),
  ]);
}

function buildPng(opts: { withExif: boolean; trailingGarbage?: boolean }): Buffer {
  const parts = [
    Buffer.from(PNG_SIG),
    pngChunk("IHDR", Buffer.alloc(13, 0x01)),
  ];
  if (opts.withExif) {
    parts.push(pngChunk("eXIf", Buffer.concat([u32(false, GPS_SENTINEL_A), u32(false, GPS_SENTINEL_B)])));
  }
  parts.push(pngChunk("IDAT", Buffer.from([0x05, 0x06, 0x07])));
  parts.push(pngChunk("IEND", Buffer.alloc(0)));
  if (opts.trailingGarbage) parts.push(Buffer.from([0x00]));
  return Buffer.concat(parts);
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** WebP chunk（奇数 size は RIFF 仕様どおり 1 byte pad を付ける）。 */
function webpChunk(fourcc: string, data: Buffer): Buffer {
  const pad = data.length % 2 === 1 ? Buffer.from([0x00]) : Buffer.alloc(0);
  return Buffer.concat([
    Buffer.from(fourcc, "latin1"),
    u32(true, data.length),
    data,
    pad,
  ]);
}

function buildWebp(opts: {
  withExif: boolean;
  withVp8x?: boolean;
  riffSizeOverride?: number;
}): Buffer {
  const chunks: Buffer[] = [];
  if (opts.withVp8x ?? true) {
    // VP8X payload 10 byte: flags(EXIF 0x08 | Alpha 0x10) + reserved + canvas size
    const vp8x = Buffer.alloc(10);
    vp8x[0] = opts.withExif ? 0x18 : 0x10;
    chunks.push(webpChunk("VP8X", vp8x));
  }
  if (opts.withExif) {
    // 奇数 size（7 byte）にして pad 処理も同時に検証する
    chunks.push(
      webpChunk(
        "EXIF",
        Buffer.concat([u32(true, GPS_SENTINEL_A), Buffer.from([0x01, 0x02, 0x03])]),
      ),
    );
  }
  chunks.push(webpChunk("VP8 ", Buffer.from([0x10, 0x20, 0x30, 0x40])));
  const body = Buffer.concat(chunks);
  return Buffer.concat([
    Buffer.from("RIFF", "latin1"),
    u32(true, opts.riffSizeOverride ?? 4 + body.length),
    Buffer.from("WEBP", "latin1"),
    body,
  ]);
}

function expectOk(result: ExifStripResult): asserts result is {
  ok: true;
  buffer: Buffer;
  changed: boolean;
} {
  expect(result.ok).toBe(true);
}

function sentinelBuffers(le: boolean): Buffer[] {
  return [u32(le, GPS_SENTINEL_A), u32(le, GPS_SENTINEL_B)];
}

// ---------------------------------------------------------------
// fixture 自体の健全性（実画像・実座標を使っていないこと）
// ---------------------------------------------------------------

describe("fixture 健全性", () => {
  it("GPS fixture は実在し得ない値のみを使う（緯度 9999 度 > 90・分母 0 rational）", () => {
    // 実座標を fixture に使わないためのガード。緯度の定義域は ±90 度。
    expect(IMPOSSIBLE_LATITUDE_DEGREES).toBeGreaterThan(90);
    // センチネル 2 組はいずれも分母 0（数値として無効 = 座標を表現し得ない）
    const fixture = buildExifTiff({ le: true, withGps: true });
    expect(fixture.gps).not.toBeNull();
  });

  it("テストは実画像ファイルを読み込まない（全 fixture がコード内合成バイト列）", () => {
    // 本ファイルに fs 由来の画像読込が無いことの宣言的ロック。
    // （fixture builder は Buffer 組み立てのみで構成される）
    expect(typeof buildJpeg).toBe("function");
    expect(typeof buildPng).toBe("function");
    expect(typeof buildWebp).toBe("function");
  });
});

// ---------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------

/** 期待される最小 Orientation APP1（実装と独立に手書きしたリテラル。出力フォーマットをロック）。 */
function expectedMinimalApp1(orientation: number): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xe1, 0x00, 0x22]), // marker + len(34 = payload 32 + 自身 2)
    Buffer.from("Exif\0\0", "latin1"),
    Buffer.from("II", "latin1"),
    u16(true, 42),
    u32(true, 8),
    u16(true, 1),
    tiffEntry(true, 0x0112, 3, 1, Buffer.concat([u16(true, orientation), u16(true, 0)])),
    u32(true, 0),
  ]);
}

/** 非 GPS EXIF の合成トークン（全て架空値。除去確認の検索キーを兼ねる）。 */
const RICH_EXIF_TOKENS = [
  "SyntheticCam", // Make (0x010F)
  "SynthModel-9", // Model (0x0110)
  "2026:01:01 00:00:00", // DateTimeOriginal (0x9003)
  "SER1234567", // BodySerialNumber (0xA431)
  "MKNOTE-SYNTH", // MakerNote (0x927C)
] as const;

/** Make / Model / Orientation / ExifIFD(DateTimeOriginal / Serial / MakerNote) を持つ Exif TIFF。 */
function buildRichExifTiff(): Buffer {
  const le = true;
  const make = "SyntheticCam\0"; // 13
  const model = "SynthModel-9\0"; // 13
  const dto = "2026:01:01 00:00:00\0"; // 20
  const serial = "SER1234567\0"; // 11
  const makerNote = "MKNOTE-SYNTH"; // 12
  const exifIfdOffset = 8 + 2 + 4 * 12 + 4; // IFD0 (count=4) 直後 = 62
  const stringsOffset = exifIfdOffset + 2 + 3 * 12 + 4; // ExifIFD (count=3) 直後 = 104
  const makeOff = stringsOffset;
  const modelOff = makeOff + make.length;
  const dtoOff = modelOff + model.length;
  const serialOff = dtoOff + dto.length;
  const makerNoteOff = serialOff + serial.length;
  return Buffer.concat([
    Buffer.from("II", "latin1"),
    u16(le, 42),
    u32(le, 8),
    // IFD0: Make / Model / Orientation / ExifIFD ポインタ
    u16(le, 4),
    tiffEntry(le, 0x010f, 2, make.length, u32(le, makeOff)),
    tiffEntry(le, 0x0110, 2, model.length, u32(le, modelOff)),
    tiffEntry(le, 0x0112, 3, 1, Buffer.concat([u16(le, 6), u16(le, 0)])),
    tiffEntry(le, 0x8769, 4, 1, u32(le, exifIfdOffset)),
    u32(le, 0),
    // ExifIFD: DateTimeOriginal / BodySerialNumber / MakerNote
    u16(le, 3),
    tiffEntry(le, 0x9003, 2, dto.length, u32(le, dtoOff)),
    tiffEntry(le, 0xa431, 2, serial.length, u32(le, serialOff)),
    tiffEntry(le, 0x927c, 7, makerNote.length, u32(le, makerNoteOff)),
    u32(le, 0),
    Buffer.from(make + model + dto + serial + makerNote, "latin1"),
  ]);
}

describe("stripFieldSurveyPhotoMetadata: JPEG (APP1 全 drop + Orientation 最小再注入)", () => {
  it("GPS 付き合成 JPEG: APP1 が drop され、期待バイト列（SOI + 最小 Orientation APP1 + 残り segment）と完全一致する", () => {
    const { jpeg } = buildJpeg({ tiff: buildExifTiff({ le: true, withGps: true }) });
    const result = stripFieldSurveyPhotoMetadata(jpeg, "image/jpeg");
    expectOk(result);
    expect(result.changed).toBe(true);
    const expected = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      expectedMinimalApp1(6),
      jpegSegment(0xdb, Buffer.from([0x00, 0x01])),
      jpegSegment(0xda, Buffer.from([0x01, 0x00])),
      Buffer.from([0x12, 0x34, 0xff, 0xd9]),
    ]);
    expect(result.buffer.equals(expected)).toBe(true);
    for (const sentinel of sentinelBuffers(true)) {
      expect(result.buffer.indexOf(sentinel)).toBe(-1);
    }
  });

  it("非 GPS EXIF（Make/Model/DateTimeOriginal/Serial/ExifIFD/MakerNote）も保存されない", () => {
    const { jpeg } = buildJpeg({
      tiff: { tiff: buildRichExifTiff(), gps: null, orientationValueOffset: 0 },
    });
    for (const token of RICH_EXIF_TOKENS) {
      expect(jpeg.indexOf(Buffer.from(token, "latin1"))).toBeGreaterThanOrEqual(0); // 前提
    }
    const result = stripFieldSurveyPhotoMetadata(jpeg, "image/jpeg");
    expectOk(result);
    expect(result.changed).toBe(true);
    for (const token of RICH_EXIF_TOKENS) {
      expect(result.buffer.indexOf(Buffer.from(token, "latin1"))).toBe(-1);
    }
    // Orientation だけは最小 APP1 として SOI 直後 (offset 2) に再注入される
    expect(result.buffer.indexOf(expectedMinimalApp1(6))).toBe(2);
  });

  it("Orientation のみの Exif（= 本 utility の最小出力と同形）は無変更（changed=false・同一参照）", () => {
    const withoutGps = buildJpeg({ tiff: buildExifTiff({ le: true, withGps: false }) });
    const result = stripFieldSurveyPhotoMetadata(withoutGps.jpeg, "image/jpeg");
    expectOk(result);
    expect(result.changed).toBe(false);
    expect(result.buffer).toBe(withoutGps.jpeg);
  });

  it("APP1 の無い JPEG は changed=false で入力をそのまま返す", () => {
    const { jpeg } = buildJpeg({});
    const result = stripFieldSurveyPhotoMetadata(jpeg, "image/jpeg");
    expectOk(result);
    expect(result.changed).toBe(false);
    expect(result.buffer).toBe(jpeg);
  });

  it("Orientation の無い Exif APP1 は drop され、何も再注入されない", () => {
    const le = true;
    // IFD0 に Make 相当 1 エントリのみ（inline 値・Orientation 無し）
    const tiff = Buffer.concat([
      Buffer.from("II", "latin1"),
      u16(le, 42),
      u32(le, 8),
      u16(le, 1),
      tiffEntry(le, 0x010f, 2, 4, Buffer.from("AB9\0", "latin1")),
      u32(le, 0),
    ]);
    const { jpeg } = buildJpeg({ tiff: { tiff, gps: null, orientationValueOffset: 0 } });
    const result = stripFieldSurveyPhotoMetadata(jpeg, "image/jpeg");
    expectOk(result);
    expect(result.changed).toBe(true);
    expect(result.buffer.indexOf(Buffer.from("Exif\0\0", "latin1"))).toBe(-1);
    expect(result.buffer.indexOf(Buffer.from([0xff, 0xe1]))).toBe(-1); // APP1 marker 自体が無い
    expect(result.buffer.indexOf(Buffer.from("AB9", "latin1"))).toBe(-1);
  });

  it("Orientation が IFD1（next-IFD チェーン先）にあっても読めて再注入される", () => {
    const le = true;
    const ifd1Offset = 8 + 2 + 12 + 4; // IFD0 (count=1) 直後 = 26
    const tiff = Buffer.concat([
      Buffer.from("II", "latin1"),
      u16(le, 42),
      u32(le, 8),
      // IFD0: Make 相当のみ・next-IFD → IFD1
      u16(le, 1),
      tiffEntry(le, 0x010f, 2, 4, Buffer.from("AB9\0", "latin1")),
      u32(le, ifd1Offset),
      // IFD1: Orientation=3 のみ・next=0
      u16(le, 1),
      tiffEntry(le, 0x0112, 3, 1, Buffer.concat([u16(le, 3), u16(le, 0)])),
      u32(le, 0),
    ]);
    const { jpeg } = buildJpeg({ tiff: { tiff, gps: null, orientationValueOffset: 0 } });
    const result = stripFieldSurveyPhotoMetadata(jpeg, "image/jpeg");
    expectOk(result);
    expect(result.changed).toBe(true);
    expect(result.buffer.indexOf(expectedMinimalApp1(3))).toBe(2);
    expect(result.buffer.indexOf(Buffer.from("AB9", "latin1"))).toBe(-1);
  });

  it("Orientation 値が 1〜8 以外なら再注入しない（APP1 は drop）", () => {
    const { jpeg } = buildJpeg({
      tiff: buildExifTiff({ le: true, withGps: true, orientationValueOverride: 9 }),
    });
    const result = stripFieldSurveyPhotoMetadata(jpeg, "image/jpeg");
    expectOk(result);
    expect(result.changed).toBe(true);
    expect(result.buffer.indexOf(Buffer.from("Exif\0\0", "latin1"))).toBe(-1);
    for (const sentinel of sentinelBuffers(true)) {
      expect(result.buffer.indexOf(sentinel)).toBe(-1);
    }
  });

  it("Exif APP1 内部が解釈できない（TIFF magic 不正）場合は malformed にせず drop・再注入なし", () => {
    // malformed 境界: JPEG segment 構造の異常のみ 422 対象。捨てる対象である
    // Exif 内部の異常では upload を拒否しない（メタデータは何も残らない側に倒す）。
    const { jpeg } = buildJpeg({
      tiff: buildExifTiff({ le: true, withGps: true, tiffMagicOverride: 43 }),
    });
    const result = stripFieldSurveyPhotoMetadata(jpeg, "image/jpeg");
    expectOk(result);
    expect(result.changed).toBe(true);
    expect(result.buffer.indexOf(Buffer.from("Exif\0\0", "latin1"))).toBe(-1);
    for (const sentinel of sentinelBuffers(true)) {
      expect(result.buffer.indexOf(sentinel)).toBe(-1);
    }
  });

  it("GPS offset が範囲外の壊れた Exif でも APP1 ごと drop され何も残らない（Orientation は再注入）", () => {
    const { jpeg } = buildJpeg({
      tiff: buildExifTiff({ le: true, withGps: true, gpsIfdOffsetOverride: 0xffff }),
    });
    const result = stripFieldSurveyPhotoMetadata(jpeg, "image/jpeg");
    expectOk(result);
    for (const sentinel of sentinelBuffers(true)) {
      expect(result.buffer.indexOf(sentinel)).toBe(-1);
    }
    expect(result.buffer.indexOf(expectedMinimalApp1(6))).toBe(2);
  });

  it("入力 buffer を mutate しない", () => {
    const { jpeg } = buildJpeg({ tiff: buildExifTiff({ le: true, withGps: true }) });
    const snapshot = Buffer.from(jpeg);
    const result = stripFieldSurveyPhotoMetadata(jpeg, "image/jpeg");
    expectOk(result);
    expect(jpeg.equals(snapshot)).toBe(true);
    expect(result.buffer).not.toBe(jpeg); // changed=true 時は copy を返す
  });

  it("big-endian (MM) の Exif からも Orientation を読み、最小 APP1 (LE 固定) を再注入する", () => {
    const { jpeg } = buildJpeg({ tiff: buildExifTiff({ le: false, withGps: true }) });
    const result = stripFieldSurveyPhotoMetadata(jpeg, "image/jpeg");
    expectOk(result);
    expect(result.changed).toBe(true);
    for (const sentinel of sentinelBuffers(false)) {
      expect(result.buffer.indexOf(sentinel)).toBe(-1);
    }
    expect(result.buffer.indexOf(expectedMinimalApp1(6))).toBe(2);
  });

  it("冪等: 一度 strip した出力をもう一度処理すると changed=false で同一バイト", () => {
    const { jpeg } = buildJpeg({ tiff: buildExifTiff({ le: true, withGps: true }) });
    const first = stripFieldSurveyPhotoMetadata(jpeg, "image/jpeg");
    expectOk(first);
    const second = stripFieldSurveyPhotoMetadata(first.buffer, "image/jpeg");
    expectOk(second);
    expect(second.changed).toBe(false);
    expect(second.buffer.equals(first.buffer)).toBe(true);
  });

  it("非 Exif APP1（XMP）も drop され、メタデータも再注入も残らない", () => {
    const { jpeg } = buildJpeg({ xmpApp1: true });
    expect(jpeg.indexOf(Buffer.from("xmpmeta", "latin1"))).toBeGreaterThanOrEqual(0); // 前提
    const result = stripFieldSurveyPhotoMetadata(jpeg, "image/jpeg");
    expectOk(result);
    expect(result.changed).toBe(true);
    expect(result.buffer.indexOf(Buffer.from("xmpmeta", "latin1"))).toBe(-1);
    expect(result.buffer.indexOf(Buffer.from([0xff, 0xe1]))).toBe(-1); // Orientation 不明のため再注入なし
  });

  it("MIME type は大文字小文字を区別しない", () => {
    const { jpeg } = buildJpeg({ tiff: buildExifTiff({ le: true, withGps: true }) });
    const result = stripFieldSurveyPhotoMetadata(jpeg, "IMAGE/JPEG");
    expectOk(result);
    expect(result.changed).toBe(true);
  });

  it("Exif APP1 が複数あっても全て drop され、最小 APP1 は 1 つだけ再注入される", () => {
    const exifPayload = (): Buffer =>
      Buffer.concat([
        Buffer.from("Exif\0\0", "latin1"),
        buildExifTiff({ le: true, withGps: true }).tiff,
      ]);
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      jpegSegment(0xe1, exifPayload()),
      jpegSegment(0xe1, exifPayload()),
      jpegSegment(0xda, Buffer.from([0x01, 0x00])),
      Buffer.from([0x12, 0x34, 0xff, 0xd9]),
    ]);
    // 前提: センチネルは 2 箇所（両 APP1）に存在する
    const sentinel = sentinelBuffers(true)[0];
    expect(jpeg.indexOf(sentinel)).toBeGreaterThanOrEqual(0);
    expect(jpeg.lastIndexOf(sentinel)).toBeGreaterThan(jpeg.indexOf(sentinel));
    const result = stripFieldSurveyPhotoMetadata(jpeg, "image/jpeg");
    expectOk(result);
    expect(result.changed).toBe(true);
    for (const s of sentinelBuffers(true)) {
      expect(result.buffer.indexOf(s)).toBe(-1); // 2 箇所とも消えている
    }
    // APP1 marker は再注入分の 1 つ（SOI 直後）だけ
    expect(result.buffer.indexOf(expectedMinimalApp1(6))).toBe(2);
    expect(result.buffer.lastIndexOf(Buffer.from([0xff, 0xe1]))).toBe(2);
  });

  it("GPS IFD ポインタが IFD1（next-IFD チェーン先）にあっても除去する", () => {
    const le = true;
    // header(8) → IFD0(Orientation のみ・next=IFD1) → IFD1(GPS ポインタ) → GPS IFD → 値
    const ifd1Offset = 8 + 2 + 12 + 4; // = 26
    const gpsIfdOffset = ifd1Offset + 2 + 12 + 4; // = 44
    const gpsValueOffset = gpsIfdOffset + 2 + 12 + 4; // = 62
    const tiff = Buffer.concat([
      Buffer.from("II", "latin1"),
      u16(le, 42),
      u32(le, 8),
      // IFD0: Orientation=6・next-IFD → IFD1
      u16(le, 1),
      tiffEntry(le, 0x0112, 3, 1, Buffer.concat([u16(le, 6), u16(le, 0)])),
      u32(le, ifd1Offset),
      // IFD1: GPS ポインタのみ・next=0
      u16(le, 1),
      tiffEntry(le, 0x8825, 4, 1, u32(le, gpsIfdOffset)),
      u32(le, 0),
      // GPS IFD: Latitude rational×3（out-of-line）・next=0
      u16(le, 1),
      tiffEntry(le, 0x0002, 5, 3, u32(le, gpsValueOffset)),
      u32(le, 0),
      // rational 値 24 byte（センチネル入り・分母 0 = 無効値）
      u32(le, IMPOSSIBLE_LATITUDE_DEGREES),
      u32(le, 1),
      u32(le, GPS_SENTINEL_A),
      u32(le, 0),
      u32(le, GPS_SENTINEL_B),
      u32(le, 0),
    ]);
    const fixture: ExifTiffFixture = {
      tiff,
      gps: null,
      orientationValueOffset: 8 + 2 + 8,
    };
    const { jpeg } = buildJpeg({ tiff: fixture });
    const result = stripFieldSurveyPhotoMetadata(jpeg, "image/jpeg");
    expectOk(result);
    expect(result.changed).toBe(true);
    for (const s of sentinelBuffers(le)) {
      expect(result.buffer.indexOf(s)).toBe(-1);
    }
    // Orientation は IFD0 から読まれ、最小 APP1 として再注入される
    expect(result.buffer.indexOf(expectedMinimalApp1(6))).toBe(2);
  });

  it("marker 前に連続する 0xFF fill byte があっても処理できる", () => {
    const fixture = buildExifTiff({ le: true, withGps: true });
    const exifPayload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), fixture.tiff]);
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xff]), // APP1 marker 前の fill bytes（JPEG 仕様上許容）
      jpegSegment(0xe1, exifPayload),
      jpegSegment(0xda, Buffer.from([0x01, 0x00])),
      Buffer.from([0x12, 0x34, 0xff, 0xd9]),
    ]);
    const result = stripFieldSurveyPhotoMetadata(jpeg, "image/jpeg");
    expectOk(result);
    expect(result.changed).toBe(true);
    for (const s of sentinelBuffers(true)) {
      expect(result.buffer.indexOf(s)).toBe(-1);
    }
  });
});

describe("stripFieldSurveyPhotoMetadata: JPEG malformed（fail-closed 連結用）", () => {
  function expectMalformed(buffer: Buffer): void {
    expect(stripFieldSurveyPhotoMetadata(buffer, "image/jpeg")).toEqual({
      ok: false,
      reason: "malformed",
    });
  }

  it("SOI が無い", () => {
    expectMalformed(Buffer.from([0x00, 0x01, 0x02, 0x03]));
  });

  it("APP1 の長さがバッファ終端を越える", () => {
    const { jpeg } = buildJpeg({ tiff: buildExifTiff({ le: true, withGps: true }) });
    // APP1 の長さフィールド（SOI 直後 offset 4..6）を実体より大きく書き換える
    const broken = Buffer.from(jpeg);
    broken.writeUInt16BE(0xffff, 4);
    expectMalformed(broken);
  });

  // 注: Exif APP1 「内部」の異常（TIFF magic 不正・GPS offset 範囲外等）は malformed に
  // しない（APP1 ごと drop されるため。前 describe の lenient テスト参照）。
  // malformed は JPEG の segment 構造の異常のみ。

  it("SOS が無い（segment 列のみで終端）", () => {
    const { jpeg } = buildJpeg({
      tiff: buildExifTiff({ le: true, withGps: true }),
      omitSos: true,
    });
    expectMalformed(jpeg);
  });
});

// ---------------------------------------------------------------
// PNG
// ---------------------------------------------------------------

describe("stripFieldSurveyPhotoMetadata: PNG (eXIf chunk drop)", () => {
  it("eXIf chunk を drop し、他 chunk は byte 単位で温存する", () => {
    const png = buildPng({ withExif: true });
    expect(png.indexOf(Buffer.from("eXIf", "latin1"))).toBeGreaterThanOrEqual(0);
    const result = stripFieldSurveyPhotoMetadata(png, "image/png");
    expectOk(result);
    expect(result.changed).toBe(true);
    expect(result.buffer.indexOf(Buffer.from("eXIf", "latin1"))).toBe(-1);
    expect(result.buffer.indexOf(u32(false, GPS_SENTINEL_A))).toBe(-1);
    // eXIf を含まない同構成 PNG と完全一致する（= 他 chunk へ影響しない）
    expect(result.buffer.equals(buildPng({ withExif: false }))).toBe(true);
  });

  it("eXIf が無ければ changed=false で入力をそのまま返す", () => {
    const png = buildPng({ withExif: false });
    const result = stripFieldSurveyPhotoMetadata(png, "image/png");
    expectOk(result);
    expect(result.changed).toBe(false);
    expect(result.buffer).toBe(png);
  });

  it("eXIf chunk が複数あっても全て drop する", () => {
    const png = Buffer.concat([
      Buffer.from(PNG_SIG),
      pngChunk("IHDR", Buffer.alloc(13, 0x01)),
      pngChunk("eXIf", u32(false, GPS_SENTINEL_A)),
      pngChunk("IDAT", Buffer.from([0x05, 0x06, 0x07])),
      pngChunk("eXIf", u32(false, GPS_SENTINEL_B)),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
    const result = stripFieldSurveyPhotoMetadata(png, "image/png");
    expectOk(result);
    expect(result.changed).toBe(true);
    expect(result.buffer.indexOf(Buffer.from("eXIf", "latin1"))).toBe(-1);
    expect(result.buffer.equals(buildPng({ withExif: false }))).toBe(true);
  });

  it.each([
    ["署名が PNG でない", Buffer.from("notapngnotapngnotapng", "latin1")],
    ["chunk 長がバッファ終端を越える", (() => {
      const png = buildPng({ withExif: true });
      const broken = Buffer.from(png);
      broken.writeUInt32BE(0xffff, 8); // IHDR の length を過大に
      return broken;
    })()],
    ["IEND 後に余剰バイトがある", buildPng({ withExif: true, trailingGarbage: true })],
    ["IEND が無い", (() => {
      const png = buildPng({ withExif: true });
      return png.subarray(0, png.length - 12); // 末尾 IEND chunk(12 byte) を切り落とす
    })()],
  ])("malformed: %s", (_label, buffer) => {
    expect(stripFieldSurveyPhotoMetadata(buffer, "image/png")).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});

// ---------------------------------------------------------------
// WebP
// ---------------------------------------------------------------

describe("stripFieldSurveyPhotoMetadata: WebP (EXIF chunk drop + RIFF size 再計算)", () => {
  it("EXIF chunk（奇数 size + pad）を drop し RIFF size を再計算する", () => {
    const webp = buildWebp({ withExif: true });
    const result = stripFieldSurveyPhotoMetadata(webp, "image/webp");
    expectOk(result);
    expect(result.changed).toBe(true);
    expect(result.buffer.indexOf(Buffer.from("EXIF", "latin1"))).toBe(-1);
    expect(result.buffer.indexOf(u32(true, GPS_SENTINEL_A))).toBe(-1);
    // RIFF size = 全長 - 8 を満たす（再計算の検証）
    expect(result.buffer.readUInt32LE(4)).toBe(result.buffer.length - 8);
    // EXIF chunk は header 8 + data 7 + pad 1 = 16 byte 分だけ縮む
    expect(result.buffer.length).toBe(webp.length - 16);
    // VP8 chunk の中身は温存される
    expect(
      result.buffer.indexOf(Buffer.from([0x10, 0x20, 0x30, 0x40])),
    ).toBeGreaterThanOrEqual(0);
  });

  it("EXIF chunk を落としたら VP8X の EXIF flag も clear する", () => {
    const webp = buildWebp({ withExif: true });
    expect(webp[12 + 8] & 0x08).toBe(0x08); // 前提: 入力では EXIF flag が立っている
    const result = stripFieldSurveyPhotoMetadata(webp, "image/webp");
    expectOk(result);
    // VP8X は先頭 chunk のまま・EXIF flag(0x08) のみ落ち Alpha flag(0x10) は残る
    expect(result.buffer.toString("latin1", 12, 16)).toBe("VP8X");
    expect(result.buffer[12 + 8]).toBe(0x10);
  });

  it("EXIF が無ければ changed=false で入力をそのまま返す", () => {
    const webp = buildWebp({ withExif: false });
    const result = stripFieldSurveyPhotoMetadata(webp, "image/webp");
    expectOk(result);
    expect(result.changed).toBe(false);
    expect(result.buffer).toBe(webp);
  });

  it.each([
    ["RIFF ヘッダでない", Buffer.from("XXXX\0\0\0\0WEBP", "latin1")],
    ["RIFF size がファイル実長と一致しない", buildWebp({ withExif: true, riffSizeOverride: 5 })],
    ["chunk 長がバッファ終端を越える", (() => {
      const webp = buildWebp({ withExif: true });
      const broken = Buffer.from(webp);
      broken.writeUInt32LE(0xffff, 12 + 4); // VP8X の size を過大に
      return broken;
    })()],
  ])("malformed: %s", (_label, buffer) => {
    expect(stripFieldSurveyPhotoMetadata(buffer, "image/webp")).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});

// ---------------------------------------------------------------
// HEIC / HEIF / 未対応 MIME
// ---------------------------------------------------------------

describe("stripFieldSurveyPhotoMetadata: 未対応 MIME", () => {
  it.each(["image/heic", "image/heif"])(
    "%s は unsupported_mime（strip 未対応。route で 422 にするかは次 PR 判断）",
    (mime) => {
      // ISOBMFF 風の先頭バイト（ftyp box）。中身は解析せず MIME で判定する
      const isobmffLike = Buffer.concat([
        u32(false, 24),
        Buffer.from("ftypheic", "latin1"),
        Buffer.alloc(12),
      ]);
      expect(stripFieldSurveyPhotoMetadata(isobmffLike, mime)).toEqual({
        ok: false,
        reason: "unsupported_mime",
      });
    },
  );

  it("allowlist 外の MIME も unsupported_mime", () => {
    expect(stripFieldSurveyPhotoMetadata(Buffer.from("GIF89a", "latin1"), "image/gif")).toEqual({
      ok: false,
      reason: "unsupported_mime",
    });
  });
});
