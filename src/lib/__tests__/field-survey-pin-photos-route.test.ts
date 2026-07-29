/**
 * /api/field-survey/pins/[id]/photos route tests (Phase 1-H).
 *
 * 検証ポイント:
 *  - POST: 成功 / MIME 不正 / サイズ超過 / 権限なし / 他人 pin 禁止 / archived 禁止 /
 *    multipart 以外 422 / AuditLog 座標・URL・storageKey・fileName 非含有
 *  - POST EXIF/GPS strip (route 接続): strip 後 buffer のみ storage.upload に渡る /
 *    HEIC・HEIF 422 / malformed fail-closed 422 / 422 レスポンス非 PII /
 *    PropertyPhoto 等への非適用 (source assertion)
 *  - GET: own / read_all / manage で他人 pin 閲覧 / 権限なし / storageKey 非返却
 *  - DELETE: own 成功 / 他人 pin 禁止 / archived 禁止 / storage.delete 失敗でも DB 削除後に成功
 *
 * fixture ポリシー: 画像は全てコード内合成バイト列のみ (実画像・実座標・実個人情報なし。
 * GPS 値は「緯度 9999 度 (>90 で実在不可)」「分母 0 rational」「0xDEADBEEF 系センチネル」のみ)。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
// route ハンドラの引数型は NextRequest。テストは Request を渡すため（runtime は
// 下の next/server mock で NextRequest=Request サブクラス）、builder/呼び出し側で
// NextRequest 相当へキャストして型を合わせる。
import type { NextRequest } from "next/server";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {
    constructor(input: string | URL | Request, init?: RequestInit) {
      super(input, init);
    }
  }
  return { NextRequest: MockNextRequest };
});

vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(),
    getUserPermissions: vi.fn(),
    handleApiError: vi.fn((error: unknown) => {
      if (error instanceof MockApiError) {
        return Response.json(
          { error: { message: error.message, code: error.code } },
          { status: error.status },
        );
      }
      return Response.json(
        { error: { message: "Server error", code: "INTERNAL_ERROR" } },
        { status: 500 },
      );
    }),
    apiResponse: vi.fn((data: unknown, status = 200) =>
      Response.json(data, { status }),
    ),
  };
});

const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));

const { storageStub } = vi.hoisted(() => ({
  storageStub: {
    upload: vi.fn(),
    delete: vi.fn(),
    getUrl: vi.fn(),
    read: vi.fn(),
  },
}));
vi.mock("@/lib/storage", () => {
  const MAX = 8 * 1024 * 1024;
  const ALLOWED = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
  ]);
  return {
    getStorage: () => storageStub,
    MAX_FILE_SIZE: MAX,
    ALLOWED_PHOTO_MIMES: ALLOWED,
    validateFile: (size: number, mime: string, allowed: Set<string>) => {
      if (size > MAX) return "ファイルサイズが上限を超えています";
      if (!allowed.has(mime)) return `許可されていないファイル形式です: ${mime}`;
      return null;
    },
  };
});

vi.mock("@/lib/prisma", () => {
  const client: Record<string, unknown> = {
    fieldSurveyPin: { findUnique: vi.fn(), updateMany: vi.fn() },
    fieldSurveyPinPhoto: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      aggregate: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
  };
  // interactive transaction: callback へ同一 client を渡す (rollback は DB の責務)
  client.$transaction = vi.fn(
    async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  );
  return { default: client };
});

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { POST, GET } from "@/app/api/field-survey/pins/[id]/photos/route";
import { DELETE } from "@/app/api/field-survey/pins/[id]/photos/[photoId]/route";

const OWNER = { id: "u-own", email: "o@x", name: "O", role: "field_staff" };
const OTHER = { id: "u-other", email: "x@x", name: "X", role: "field_staff" };

const writePerms = [
  { resource: "field_survey", action: "read", granted: true },
  { resource: "field_survey", action: "write", granted: true },
];
const readOnlyPerms = [
  { resource: "field_survey", action: "read", granted: true },
];
const readAllPerms = [
  { resource: "field_survey", action: "read", granted: true },
  { resource: "field_survey", action: "read_all", granted: true },
];
const noPerms: { resource: string; action: string; granted: boolean }[] = [];

const PIN_ID = "11111111-1111-1111-1111-111111111111";
const PHOTO_ID = "22222222-2222-2222-2222-222222222222";

function paramsP(id: string) {
  return { params: Promise.resolve({ id }) };
}
function paramsDel(id: string, photoId: string) {
  return { params: Promise.resolve({ id, photoId }) };
}

function multipartReq(file: Blob | null) {
  const fd = new FormData();
  if (file) fd.append("file", file, "photo.jpg");
  return new Request(`http://t/api/field-survey/pins/${PIN_ID}/photos`, {
    method: "POST",
    body: fd,
  }) as unknown as NextRequest;
}

// ---------- EXIF strip 用 合成バイト fixture ----------
// route が保存前に stripFieldSurveyPhotoMetadata (実体・mock しない) を通すため、
// 画像 fixture は strip が構造検証を通せる「有効な最小合成バイト列」である必要がある。
// 値は実在し得ないもののみ: 緯度 9999 度 (>90) / 分母 0 rational / 0xDEADBEEF センチネル。

const GPS_SENTINEL = Buffer.from([0xef, 0xbe, 0xad, 0xde]); // 0xDEADBEEF (LE)

function u16le(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
}
function u32le(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
}
function u16be(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v);
  return b;
}
function u32be(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v >>> 0);
  return b;
}
function tiffEntryLE(tag: number, type: number, count: number, value: Buffer): Buffer {
  return Buffer.concat([u16le(tag), u16le(type), u32le(count), value]);
}

/** SOI + SOS + entropy + EOI の最小 JPEG。padTo 指定でゼロ padding (SOS 以降は無検証)。 */
function minimalJpegBytes(padTo = 0): Buffer {
  const base = Buffer.from([
    0xff, 0xd8, // SOI
    0xff, 0xda, 0x00, 0x04, 0x01, 0x00, // SOS
    0x12, 0x34, 0xff, 0xd9, // entropy + EOI
  ]);
  if (padTo <= base.length) return base;
  return Buffer.concat([base, Buffer.alloc(padTo - base.length)]);
}

/** Orientation(=6) + GPS IFD (Latitude rational×3 out-of-line) を持つ Exif APP1 入り JPEG。 */
function jpegWithGpsBytes(): { bytes: Buffer; orientationValueAbs: number } {
  const ifd0Offset = 8;
  const gpsIfdOffset = ifd0Offset + 2 + 2 * 12 + 4; // IFD0 直後
  const gpsValueOffset = gpsIfdOffset + 2 + 2 * 12 + 4;
  const tiff = Buffer.concat([
    Buffer.from("II", "latin1"),
    u16le(42),
    u32le(ifd0Offset),
    // IFD0: Orientation=6 + GPSInfo ポインタ
    u16le(2),
    tiffEntryLE(0x0112, 3, 1, Buffer.concat([u16le(6), u16le(0)])),
    tiffEntryLE(0x8825, 4, 1, u32le(gpsIfdOffset)),
    u32le(0),
    // GPS IFD: LatitudeRef "N\0" + Latitude rational×3 (out-of-line)
    u16le(2),
    tiffEntryLE(0x0001, 2, 2, Buffer.from("N\0\0\0", "latin1")),
    tiffEntryLE(0x0002, 5, 3, u32le(gpsValueOffset)),
    u32le(0),
    // 緯度 9999 度 (実在不可) + 分母 0 のセンチネル rational
    u32le(9999),
    u32le(1),
    u32le(0xdeadbeef),
    u32le(0),
    u32le(0xfeedface),
    u32le(0),
  ]);
  const exifPayload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const bytes = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe1]),
    u16be(exifPayload.length + 2),
    exifPayload,
    Buffer.from([0xff, 0xda, 0x00, 0x04, 0x01, 0x00]),
    Buffer.from([0x12, 0x34, 0xff, 0xd9]),
  ]);
  // TIFF 先頭 = SOI(2) + APP1 marker(2) + len(2) + "Exif\0\0"(6) = 12
  return { bytes, orientationValueAbs: 12 + ifd0Offset + 2 + 8 };
}

/**
 * 非 GPS EXIF（Make / Model / DateTimeOriginal / Serial / MakerNote）を持つ Exif APP1 入り
 * JPEG。値は全て架空の合成文字列のみ（Codex 指摘: GPS なし EXIF も保存しない、の検証用）。
 */
function jpegWithRichExifBytes(): Buffer {
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
  const tiff = Buffer.concat([
    Buffer.from("II", "latin1"),
    u16le(42),
    u32le(8),
    // IFD0: Make / Model / Orientation / ExifIFD ポインタ
    u16le(4),
    tiffEntryLE(0x010f, 2, make.length, u32le(makeOff)),
    tiffEntryLE(0x0110, 2, model.length, u32le(modelOff)),
    tiffEntryLE(0x0112, 3, 1, Buffer.concat([u16le(6), u16le(0)])),
    tiffEntryLE(0x8769, 4, 1, u32le(exifIfdOffset)),
    u32le(0),
    // ExifIFD: DateTimeOriginal / BodySerialNumber / MakerNote
    u16le(3),
    tiffEntryLE(0x9003, 2, dto.length, u32le(dtoOff)),
    tiffEntryLE(0xa431, 2, serial.length, u32le(serialOff)),
    tiffEntryLE(0x927c, 7, makerNote.length, u32le(makerNoteOff)),
    u32le(0),
    Buffer.from(make + model + dto + serial + makerNote, "latin1"),
  ]);
  const exifPayload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe1]),
    u16be(exifPayload.length + 2),
    exifPayload,
    Buffer.from([0xff, 0xda, 0x00, 0x04, 0x01, 0x00]),
    Buffer.from([0x12, 0x34, 0xff, 0xd9]),
  ]);
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngChunk(type: string, data: Buffer): Buffer {
  // CRC は strip utility が検証しないため固定ダミー
  return Buffer.concat([
    u32be(data.length),
    Buffer.from(type, "latin1"),
    data,
    Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]),
  ]);
}
function pngBytes(withExif: boolean): Buffer {
  return Buffer.concat([
    PNG_SIG,
    pngChunk("IHDR", Buffer.alloc(13, 0x01)),
    ...(withExif ? [pngChunk("eXIf", GPS_SENTINEL)] : []),
    pngChunk("IDAT", Buffer.from([0x05, 0x06, 0x07])),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function webpChunkBytes(fourcc: string, data: Buffer): Buffer {
  const pad = data.length % 2 === 1 ? Buffer.from([0x00]) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from(fourcc, "latin1"), u32le(data.length), data, pad]);
}
function webpBytes(withExif: boolean): Buffer {
  const body = Buffer.concat([
    ...(withExif ? [webpChunkBytes("EXIF", GPS_SENTINEL)] : []),
    webpChunkBytes("VP8 ", Buffer.from([0x10, 0x20, 0x30, 0x40])),
  ]);
  return Buffer.concat([
    Buffer.from("RIFF", "latin1"),
    u32le(4 + body.length),
    Buffer.from("WEBP", "latin1"),
    body,
  ]);
}

/** MIME に対応する「strip を通過できる有効バイト列」。strip 対象外 MIME はゼロ埋めのまま。 */
// 戻り型は注釈しない (明示すると Uint8Array<ArrayBufferLike> に広がり BlobPart と不適合。
// 各分岐の new Uint8Array(...) は Uint8Array<ArrayBuffer> に推論される)。
function validBytesFor(type: string) {
  if (type === "image/jpeg") return new Uint8Array(minimalJpegBytes());
  if (type === "image/png") return new Uint8Array(pngBytes(false));
  if (type === "image/webp") return new Uint8Array(webpBytes(false));
  return new Uint8Array(16);
}

function jpeg(bytes = 16): Blob {
  // strip 導入後はゼロ埋めだと malformed 422 になるため、有効な最小 JPEG + padding。
  return new Blob([new Uint8Array(minimalJpegBytes(bytes))], { type: "image/jpeg" });
}

beforeEach(() => {
  vi.clearAllMocks();
  // server adapter を模し、result.url は storage server 直の絶対 URL を返す。
  // route はこれを保存せず /uploads/{key} を組み立てることを各テストで検証する。
  storageStub.upload.mockResolvedValue({
    url: "http://storage.internal:9000/files/server-direct.jpg",
    key: `field-survey/pins/${PIN_ID}/photos/abc.jpg`,
  });
  storageStub.delete.mockResolvedValue(undefined);
  (prisma.fieldSurveyPinPhoto.aggregate as ReturnType<typeof vi.fn>).mockResolvedValue({
    _max: { sortOrder: null },
  });
  // POST は tx 内でピン行を条件付き touch して archived の並行遷移を弾く
  // （総点検P3）。既定は「1 件成功」に倒し、並行 archive の検証テストだけ
  // 0 に上書きする。
  (
    prisma.fieldSurveyPin.updateMany as ReturnType<typeof vi.fn>
  ).mockResolvedValue({ count: 1 });
});

describe("POST photos", () => {
  it("検証後に並行 archive されたら 409 + upload 済み実体を回収する（総点検P3）", async () => {
    // 冒頭の archived チェックは通ったが、tx 内の条件付き touch までに別タブ /
    // 別端末の DELETE (archive) が先行した。アーカイブ済みピンに写真が付くと
    // UI から見えない場所に入るため、409 で rollback し blob も best-effort 削除。
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue(OWNER);
    (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(writePerms);
    (prisma.fieldSurveyPin.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: PIN_ID,
      staffUserId: OWNER.id,
      status: "open", // 事前チェックは通る
    });
    (
      prisma.fieldSurveyPin.updateMany as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({ count: 0 }); // tx 内 touch で並行 archive が判明
    const res = await POST(multipartReq(jpeg()), paramsP(PIN_ID));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_STATE");
    // touch の条件 = archived でないこと（status を書き戻さない・touch のみ）
    const guardArgs = (
      prisma.fieldSurveyPin.updateMany as ReturnType<typeof vi.fn>
    ).mock.calls[0][0];
    expect(guardArgs.where).toEqual({ id: PIN_ID, status: { not: "archived" } });
    expect(Object.keys(guardArgs.data)).toEqual(["updatedAt"]);
    // DB 行は作られず、直前に upload した実体は回収される
    expect(prisma.fieldSurveyPinPhoto.create).not.toHaveBeenCalled();
    expect(storageStub.delete).toHaveBeenCalledWith(
      `field-survey/pins/${PIN_ID}/photos/abc.jpg`,
    );
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("own pin + write で成功し、AuditLog に URL/storageKey/fileName を含めない", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue(OWNER);
    (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(writePerms);
    (prisma.fieldSurveyPin.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: PIN_ID,
      staffUserId: OWNER.id,
      status: "open",
    });
    (prisma.fieldSurveyPinPhoto.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: PHOTO_ID,
      pinId: PIN_ID,
      fileUrl: `/uploads/field-survey/pins/${PIN_ID}/photos/1.jpg`,
      thumbnailUrl: null,
      fileName: "photo.jpg",
      fileSize: 16,
      mimeType: "image/jpeg",
      sortOrder: 0,
      createdAt: new Date().toISOString(),
    });

    const res = await POST(multipartReq(jpeg()), paramsP(PIN_ID));
    expect(res.status).toBe(201);
    expect(storageStub.upload).toHaveBeenCalledTimes(1);
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    const detail = (writeAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0].detail;
    expect(detail).toEqual({ pinId: PIN_ID, photoId: PHOTO_ID });
    const serialized = JSON.stringify(
      (writeAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0],
    );
    expect(serialized).not.toMatch(/uploads|\.jpg|photo\.jpg|lat|lng/);
  });

  it("MIME 不正は 422 で upload しない", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue(OWNER);
    (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(writePerms);
    (prisma.fieldSurveyPin.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: PIN_ID,
      staffUserId: OWNER.id,
      status: "open",
    });
    const res = await POST(
      multipartReq(new Blob([new Uint8Array(8)], { type: "application/pdf" })),
      paramsP(PIN_ID),
    );
    expect(res.status).toBe(422);
    expect(storageStub.upload).not.toHaveBeenCalled();
  });

  it("サイズ超過は 422 で upload しない", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue(OWNER);
    (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(writePerms);
    (prisma.fieldSurveyPin.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: PIN_ID,
      staffUserId: OWNER.id,
      status: "open",
    });
    const res = await POST(
      multipartReq(jpeg(8 * 1024 * 1024 + 1)),
      paramsP(PIN_ID),
    );
    expect(res.status).toBe(422);
    expect(storageStub.upload).not.toHaveBeenCalled();
  });

  it("write 権限なしは 403", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue(OWNER);
    (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(readOnlyPerms);
    const res = await POST(multipartReq(jpeg()), paramsP(PIN_ID));
    expect(res.status).toBe(403);
  });

  it("他人 pin への追加は 403 (read_all/manage でも不可)", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue(OWNER);
    (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue([
      ...writePerms,
      { resource: "field_survey", action: "manage", granted: true },
    ]);
    (prisma.fieldSurveyPin.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: PIN_ID,
      staffUserId: OTHER.id,
      status: "open",
    });
    const res = await POST(multipartReq(jpeg()), paramsP(PIN_ID));
    expect(res.status).toBe(403);
    expect(storageStub.upload).not.toHaveBeenCalled();
  });

  it("archived pin への追加は 409", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue(OWNER);
    (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(writePerms);
    (prisma.fieldSurveyPin.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: PIN_ID,
      staffUserId: OWNER.id,
      status: "archived",
    });
    const res = await POST(multipartReq(jpeg()), paramsP(PIN_ID));
    expect(res.status).toBe(409);
  });

  it("multipart 以外は 422", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue(OWNER);
    (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(writePerms);
    (prisma.fieldSurveyPin.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: PIN_ID,
      staffUserId: OWNER.id,
      status: "open",
    });
    const req = new Request(`http://t/api/field-survey/pins/${PIN_ID}/photos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }) as unknown as NextRequest;
    const res = await POST(req, paramsP(PIN_ID));
    expect(res.status).toBe(422);
  });
});

describe("POST photos — MIME / key hardening (Codex P2)", () => {
  function setupOwnOpenPin() {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue(OWNER);
    (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(writePerms);
    (prisma.fieldSurveyPin.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: PIN_ID,
      staffUserId: OWNER.id,
      status: "open",
    });
    (prisma.fieldSurveyPinPhoto.create as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: PHOTO_ID,
        pinId: PIN_ID,
        fileUrl: data.fileUrl,
        thumbnailUrl: null,
        fileName: data.fileName,
        fileSize: data.fileSize,
        mimeType: data.mimeType,
        sortOrder: 0,
        createdAt: new Date().toISOString(),
      }),
    );
  }

  const lastUploadKey = (): string =>
    (storageStub.upload as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1].key;

  // Content-Type を持たせず multipart part を送る (file.type === "")。
  function noTypeReq() {
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(16)]), "evil.jpg");
    return new Request(`http://t/api/field-survey/pins/${PIN_ID}/photos`, {
      method: "POST",
      body: fd,
    }) as unknown as NextRequest;
  }

  function typedReq(type: string, name: string) {
    const fd = new FormData();
    fd.append("file", new Blob([validBytesFor(type)], { type }), name);
    return new Request(`http://t/api/field-survey/pins/${PIN_ID}/photos`, {
      method: "POST",
      body: fd,
    }) as unknown as NextRequest;
  }

  it("Content-Type 空の file は 422 で拒否され image/jpeg に fallback しない", async () => {
    setupOwnOpenPin();
    const res = await POST(noTypeReq(), paramsP(PIN_ID));
    expect(res.status).toBe(422);
    expect(storageStub.upload).not.toHaveBeenCalled();
    expect(prisma.fieldSurveyPinPhoto.create).not.toHaveBeenCalled();
  });

  it("実際の file.type を使い、fileName 拡張子に依存しない (ext は MIME 由来)", async () => {
    setupOwnOpenPin();
    const res = await POST(typedReq("image/png", "looks-like.jpg"), paramsP(PIN_ID));
    expect(res.status).toBe(201);
    const arg = (storageStub.upload as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1];
    expect(arg.mimeType).toBe("image/png");
    expect(lastUploadKey()).toMatch(/\.png$/);
    expect(lastUploadKey()).not.toMatch(/looks-like|\.jpg/);
  });

  it("key は randomUUID を含み、元 fileName を含まず path traversal しない", async () => {
    setupOwnOpenPin();
    const res = await POST(typedReq("image/jpeg", "../../etc/passwd.jpg"), paramsP(PIN_ID));
    expect(res.status).toBe(201);
    const key = lastUploadKey();
    expect(key).toMatch(
      new RegExp(
        `^field-survey/pins/${PIN_ID}/photos/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.jpg$`,
      ),
    );
    expect(key).not.toContain("..");
    expect(key).not.toContain("passwd");
  });

  it("同一 pin / 同一拡張子の連続 upload でも key が衝突しない", async () => {
    setupOwnOpenPin();
    await POST(typedReq("image/jpeg", "a.jpg"), paramsP(PIN_ID));
    await POST(typedReq("image/jpeg", "a.jpg"), paramsP(PIN_ID));
    const calls = (storageStub.upload as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[0][1].key).not.toBe(calls[1][1].key);
  });
});

describe("POST photos — app proxy url (Codex P1)", () => {
  function setupOwnOpenPinEcho() {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue(OWNER);
    (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(writePerms);
    (prisma.fieldSurveyPin.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: PIN_ID,
      staffUserId: OWNER.id,
      status: "open",
    });
    (prisma.fieldSurveyPinPhoto.create as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: PHOTO_ID,
        pinId: PIN_ID,
        fileUrl: data.fileUrl,
        thumbnailUrl: data.thumbnailUrl,
        fileName: data.fileName,
        fileSize: data.fileSize,
        mimeType: data.mimeType,
        sortOrder: 0,
        createdAt: new Date().toISOString(),
      }),
    );
  }
  const createdData = (): Record<string, unknown> =>
    (prisma.fieldSurveyPinPhoto.create as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]
      .data;

  function typedReq(type: string, name = "photo.jpg") {
    const fd = new FormData();
    fd.append("file", new Blob([validBytesFor(type)], { type }), name);
    return new Request(`http://t/api/field-survey/pins/${PIN_ID}/photos`, {
      method: "POST",
      body: fd,
    }) as unknown as NextRequest;
  }

  it("result.url が絶対URLでも fileUrl は /uploads/{key} で保存され http(s) で始まらない", async () => {
    setupOwnOpenPinEcho();
    const res = await POST(typedReq("image/jpeg"), paramsP(PIN_ID));
    expect(res.status).toBe(201);
    const data = createdData();
    expect(String(data.fileUrl)).toMatch(/^\/uploads\/field-survey\/pins\//);
    expect(String(data.fileUrl)).not.toMatch(/^https?:/);
    // adapter が返した result.key (= 実際に格納された key) を proxy 化したもの。
    // result.url (絶対URL) ではなく result.key を使うことを確認する。
    expect(data.fileUrl).toBe(
      `/uploads/field-survey/pins/${PIN_ID}/photos/abc.jpg`,
    );
  });

  it("thumbnailUrl が絶対URLなら保存しない (null)", async () => {
    setupOwnOpenPinEcho();
    storageStub.upload.mockResolvedValueOnce({
      url: "http://storage.internal:9000/files/x.jpg",
      thumbnailUrl: "http://storage.internal:9000/files/x-thumb.jpg",
      key: `field-survey/pins/${PIN_ID}/photos/abc.jpg`,
    });
    const res = await POST(typedReq("image/jpeg"), paramsP(PIN_ID));
    expect(res.status).toBe(201);
    expect(createdData().thumbnailUrl).toBeNull();
  });

  it("thumbnailUrl が /uploads 相対なら proxy URL として保持する", async () => {
    setupOwnOpenPinEcho();
    storageStub.upload.mockResolvedValueOnce({
      url: "http://storage.internal:9000/files/x.jpg",
      thumbnailUrl: `/uploads/field-survey/pins/${PIN_ID}/photos/abc-thumb.jpg`,
      key: `field-survey/pins/${PIN_ID}/photos/abc.jpg`,
    });
    const res = await POST(typedReq("image/jpeg"), paramsP(PIN_ID));
    expect(res.status).toBe(201);
    expect(createdData().thumbnailUrl).toBe(
      `/uploads/field-survey/pins/${PIN_ID}/photos/abc-thumb.jpg`,
    );
  });
});

describe("POST photos — EXIF/GPS strip (route 接続)", () => {
  function setupOwnOpenPinEcho() {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue(OWNER);
    (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(writePerms);
    (prisma.fieldSurveyPin.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: PIN_ID,
      staffUserId: OWNER.id,
      status: "open",
    });
    (prisma.fieldSurveyPinPhoto.create as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: PHOTO_ID,
        pinId: PIN_ID,
        fileUrl: data.fileUrl,
        thumbnailUrl: null,
        fileName: data.fileName,
        fileSize: data.fileSize,
        mimeType: data.mimeType,
        sortOrder: 0,
        createdAt: new Date().toISOString(),
      }),
    );
  }

  function reqWith(bytes: Buffer | Uint8Array, type: string, name = "photo.jpg") {
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(bytes)], { type }), name);
    return new Request(`http://t/api/field-survey/pins/${PIN_ID}/photos`, {
      method: "POST",
      body: fd,
    }) as unknown as NextRequest;
  }

  /** storage.upload に渡された buffer (第1引数)。 */
  const uploadedBuffer = (): Buffer =>
    (storageStub.upload as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
  const createdData = (): Record<string, unknown> =>
    (prisma.fieldSurveyPinPhoto.create as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]
      .data;

  it("JPEG: GPS 付き合成バイトは strip 後 buffer が storage.upload に渡る (APP1 drop・Orientation 保持)", async () => {
    setupOwnOpenPinEcho();
    const { bytes, orientationValueAbs } = jpegWithGpsBytes();
    expect(bytes.indexOf(GPS_SENTINEL)).toBeGreaterThanOrEqual(0); // 前提: 入力に GPS あり
    const res = await POST(reqWith(bytes, "image/jpeg"), paramsP(PIN_ID));
    expect(res.status).toBe(201);
    expect(storageStub.upload).toHaveBeenCalledTimes(1);
    const uploaded = uploadedBuffer();
    expect(uploaded.indexOf(GPS_SENTINEL)).toBe(-1); // GPS は保存バイトに残らない
    expect(uploaded.length).toBeLessThan(bytes.length); // APP1 drop + 最小再注入で縮む
    // Orientation は最小 APP1 (SOI 直後) として再注入される。value field の絶対位置は
    // SOI(2)+marker(2)+len(2)+"Exif\0\0"(6)+TIFF header(8)+count(2)+tag/type/count(8) = 30
    // （元 fixture の orientationValueAbs と同値になる配置）
    expect(uploaded.readUInt16LE(orientationValueAbs)).toBe(6);
    expect(uploaded.equals(bytes)).toBe(false); // 原本そのままは保存しない
    // DB の fileSize は保存実体 (strip 後 buffer) のサイズ
    expect(createdData().fileSize).toBe(uploaded.length);
  });

  it("JPEG: GPS なしの通常 EXIF (Make/Model/DateTimeOriginal/Serial/ExifIFD/MakerNote) も保存されない (Codex 指摘対応)", async () => {
    setupOwnOpenPinEcho();
    const tokens = [
      "SyntheticCam", // Make
      "SynthModel-9", // Model
      "2026:01:01 00:00:00", // DateTimeOriginal
      "SER1234567", // BodySerialNumber
      "MKNOTE-SYNTH", // MakerNote
    ];
    const bytes = jpegWithRichExifBytes();
    for (const token of tokens) {
      expect(bytes.indexOf(Buffer.from(token, "latin1"))).toBeGreaterThanOrEqual(0); // 前提
    }
    const res = await POST(reqWith(bytes, "image/jpeg"), paramsP(PIN_ID));
    expect(res.status).toBe(201);
    const uploaded = uploadedBuffer();
    for (const token of tokens) {
      expect(uploaded.indexOf(Buffer.from(token, "latin1"))).toBe(-1);
    }
    // Orientation のみ最小 APP1 で保持される（value field 絶対位置 30）
    expect(uploaded.readUInt16LE(30)).toBe(6);
  });

  it("PNG: eXIf chunk 付きは drop 済 buffer が渡る", async () => {
    setupOwnOpenPinEcho();
    const bytes = pngBytes(true);
    const res = await POST(reqWith(bytes, "image/png"), paramsP(PIN_ID));
    expect(res.status).toBe(201);
    const uploaded = uploadedBuffer();
    expect(uploaded.indexOf(Buffer.from("eXIf", "latin1"))).toBe(-1);
    expect(uploaded.indexOf(GPS_SENTINEL)).toBe(-1);
    expect(uploaded.equals(pngBytes(false))).toBe(true); // eXIf 以外は byte 単位で温存
  });

  it("WebP: EXIF chunk 付きは drop 済 + RIFF size 再計算済 buffer が渡る", async () => {
    setupOwnOpenPinEcho();
    const bytes = webpBytes(true);
    const res = await POST(reqWith(bytes, "image/webp"), paramsP(PIN_ID));
    expect(res.status).toBe(201);
    const uploaded = uploadedBuffer();
    expect(uploaded.indexOf(Buffer.from("EXIF", "latin1"))).toBe(-1);
    expect(uploaded.indexOf(GPS_SENTINEL)).toBe(-1);
    expect(uploaded.readUInt32LE(4)).toBe(uploaded.length - 8); // RIFF size 再計算
  });

  it("metadata 無し画像は変更なしで正常保存される (バイト同一)", async () => {
    setupOwnOpenPinEcho();
    const bytes = minimalJpegBytes();
    const res = await POST(reqWith(bytes, "image/jpeg"), paramsP(PIN_ID));
    expect(res.status).toBe(201);
    expect(uploadedBuffer().equals(bytes)).toBe(true);
  });

  it.each(["image/heic", "image/heif"])(
    "%s は 422 で storage.upload / DB / audit を行わない",
    async (mime) => {
      setupOwnOpenPinEcho();
      const res = await POST(
        reqWith(Buffer.from("ftypheic-stub", "latin1"), mime, "secret-spot.heic"),
        paramsP(PIN_ID),
      );
      expect(res.status).toBe(422);
      expect(storageStub.upload).not.toHaveBeenCalled();
      expect(prisma.fieldSurveyPinPhoto.create).not.toHaveBeenCalled();
      expect(writeAuditLog).not.toHaveBeenCalled();
      const body = await res.json();
      expect(body.error.message).toBe(
        "この画像形式は現地調査写真では現在サポートされていません。JPEG / PNG / WebP を使用してください。",
      );
    },
  );

  it("malformed (中身が JPEG でない image/jpeg) は fail-closed 422 で upload しない", async () => {
    setupOwnOpenPinEcho();
    const res = await POST(
      reqWith(new Uint8Array(16), "image/jpeg", "secret-spot.jpg"),
      paramsP(PIN_ID),
    );
    expect(res.status).toBe(422);
    expect(storageStub.upload).not.toHaveBeenCalled();
    expect(prisma.fieldSurveyPinPhoto.create).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error.message).toBe("画像ファイルを処理できませんでした。");
  });

  it("422 レスポンスに fileName / key / path / 座標を含めない (HEIC・malformed 両方)", async () => {
    setupOwnOpenPinEcho();
    const heicRes = await POST(
      reqWith(Buffer.from("ftypheic-stub", "latin1"), "image/heic", "secret-spot.heic"),
      paramsP(PIN_ID),
    );
    const malformedRes = await POST(
      reqWith(new Uint8Array(16), "image/jpeg", "secret-spot.jpg"),
      paramsP(PIN_ID),
    );
    for (const res of [heicRes, malformedRes]) {
      expect(res.status).toBe(422);
      const serialized = JSON.stringify(await res.json());
      expect(serialized).not.toMatch(
        /secret-spot|uploads|field-survey\/pins|storageKey|lat|lng|9999/,
      );
    }
  });

  it("strip 成功時の audit detail は従来どおり {pinId, photoId} のみ", async () => {
    setupOwnOpenPinEcho();
    const res = await POST(reqWith(jpegWithGpsBytes().bytes, "image/jpeg"), paramsP(PIN_ID));
    expect(res.status).toBe(201);
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    const call = (writeAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.detail).toEqual({ pinId: PIN_ID, photoId: PHOTO_ID });
    expect(JSON.stringify(call)).not.toMatch(/uploads|\.jpg|photo\.jpg|lat|lng|exif/i);
  });

  // ---- 非適用ロック (source assertion): strip は field-survey photos route 限定 ----
  function readSource(rel: string): string {
    return fs.readFileSync(path.resolve(process.cwd(), rel), "utf8");
  }

  it("PropertyPhoto / BuildingPhoto / attachments route は exif-strip を import しない", () => {
    const untouched = [
      "src/app/api/properties/[id]/photos/route.ts",
      "src/app/api/buildings/[id]/photos/route.ts",
      "src/app/api/properties/[id]/attachments/route.ts",
    ];
    for (const rel of untouched) {
      expect(readSource(rel), `${rel} は EXIF strip 非適用のまま`).not.toContain(
        "exif-strip",
      );
    }
    // 適用先は field-survey photos route のみ
    expect(
      readSource("src/app/api/field-survey/pins/[id]/photos/route.ts"),
    ).toContain('from "@/lib/field-survey/exif-strip"');
  });
});

describe("GET photos", () => {
  it("own pin を read で取得し storageKey を返さない", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue(OWNER);
    (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(readOnlyPerms);
    (prisma.fieldSurveyPin.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: PIN_ID,
      staffUserId: OWNER.id,
    });
    (prisma.fieldSurveyPinPhoto.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: PHOTO_ID,
        pinId: PIN_ID,
        fileUrl: `/uploads/field-survey/pins/${PIN_ID}/photos/1.jpg`,
        thumbnailUrl: null,
        fileName: "photo.jpg",
        fileSize: 16,
        mimeType: "image/jpeg",
        sortOrder: 0,
        createdAt: new Date().toISOString(),
      },
    ]);
    const res = await GET(new Request("http://t") as unknown as NextRequest, paramsP(PIN_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toMatch(/storageKey/);
    expect(body.data[0].fileUrl).toMatch(/^\/uploads\//);
    expect(body.data[0].fileUrl).not.toMatch(/^https?:/);
  });

  it("他人 pin は read_all で閲覧可", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue(OWNER);
    (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(readAllPerms);
    (prisma.fieldSurveyPin.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: PIN_ID,
      staffUserId: OTHER.id,
    });
    (prisma.fieldSurveyPinPhoto.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const res = await GET(new Request("http://t") as unknown as NextRequest, paramsP(PIN_ID));
    expect(res.status).toBe(200);
  });

  it("他人 pin を read のみで閲覧は 403", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue(OWNER);
    (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(readOnlyPerms);
    (prisma.fieldSurveyPin.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: PIN_ID,
      staffUserId: OTHER.id,
    });
    const res = await GET(new Request("http://t") as unknown as NextRequest, paramsP(PIN_ID));
    expect(res.status).toBe(403);
  });

  it("read 権限なしは 403", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue(OWNER);
    (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(noPerms);
    const res = await GET(new Request("http://t") as unknown as NextRequest, paramsP(PIN_ID));
    expect(res.status).toBe(403);
  });
});

describe("DELETE photo", () => {
  function mockPhoto(
    staffUserId: string,
    status = "open",
    thumbnailUrl: string | null = null,
  ) {
    (prisma.fieldSurveyPinPhoto.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: PHOTO_ID,
      pinId: PIN_ID,
      fileUrl: `/uploads/field-survey/pins/${PIN_ID}/photos/1.jpg`,
      thumbnailUrl,
      pin: { staffUserId, status },
    });
    (prisma.fieldSurveyPinPhoto.delete as ReturnType<typeof vi.fn>).mockResolvedValue({});
  }

  it("own pin 写真を削除し fileUrl から復元した key で storage.delete を呼ぶ", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue(OWNER);
    (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(writePerms);
    mockPhoto(OWNER.id);
    const res = await DELETE(new Request("http://t") as unknown as NextRequest, paramsDel(PIN_ID, PHOTO_ID));
    expect(res.status).toBe(200);
    expect(prisma.fieldSurveyPinPhoto.delete).toHaveBeenCalledTimes(1);
    expect(storageStub.delete).toHaveBeenCalledTimes(1);
    expect(storageStub.delete).toHaveBeenCalledWith(
      `field-survey/pins/${PIN_ID}/photos/1.jpg`,
    );
    const detail = (writeAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0].detail;
    expect(detail).toEqual({ pinId: PIN_ID, photoId: PHOTO_ID });
  });

  it("thumbnailUrl がある場合は本体 + thumbnail の両方を storage.delete する", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue(OWNER);
    (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(writePerms);
    mockPhoto(
      OWNER.id,
      "open",
      `/uploads/field-survey/pins/${PIN_ID}/photos/1-thumb.jpg`,
    );
    const res = await DELETE(new Request("http://t") as unknown as NextRequest, paramsDel(PIN_ID, PHOTO_ID));
    expect(res.status).toBe(200);
    expect(storageStub.delete).toHaveBeenCalledTimes(2);
    expect(storageStub.delete).toHaveBeenCalledWith(
      `field-survey/pins/${PIN_ID}/photos/1.jpg`,
    );
    expect(storageStub.delete).toHaveBeenCalledWith(
      `field-survey/pins/${PIN_ID}/photos/1-thumb.jpg`,
    );
  });

  it("他人 pin の写真削除は 403", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue(OWNER);
    (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue([
      ...writePerms,
      { resource: "field_survey", action: "manage", granted: true },
    ]);
    mockPhoto(OTHER.id);
    const res = await DELETE(new Request("http://t") as unknown as NextRequest, paramsDel(PIN_ID, PHOTO_ID));
    expect(res.status).toBe(403);
    expect(prisma.fieldSurveyPinPhoto.delete).not.toHaveBeenCalled();
  });

  it("archived pin の写真削除は 409", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue(OWNER);
    (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(writePerms);
    mockPhoto(OWNER.id, "archived");
    const res = await DELETE(new Request("http://t") as unknown as NextRequest, paramsDel(PIN_ID, PHOTO_ID));
    expect(res.status).toBe(409);
    expect(prisma.fieldSurveyPinPhoto.delete).not.toHaveBeenCalled();
  });

  it("storage.delete 失敗でも DB 削除後に API は成功する", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue(OWNER);
    (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(writePerms);
    mockPhoto(OWNER.id);
    storageStub.delete.mockRejectedValueOnce(new Error("network"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await DELETE(new Request("http://t") as unknown as NextRequest, paramsDel(PIN_ID, PHOTO_ID));
    expect(res.status).toBe(200);
    expect(prisma.fieldSurveyPinPhoto.delete).toHaveBeenCalledTimes(1);
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });
});
