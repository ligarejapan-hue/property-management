/**
 * /api/field-survey/pins/[id]/photos route tests (Phase 1-H).
 *
 * 検証ポイント:
 *  - POST: 成功 / MIME 不正 / サイズ超過 / 権限なし / 他人 pin 禁止 / archived 禁止 /
 *    multipart 以外 422 / AuditLog 座標・URL・storageKey・fileName 非含有
 *  - GET: own / read_all / manage で他人 pin 閲覧 / 権限なし / storageKey 非返却
 *  - DELETE: own 成功 / 他人 pin 禁止 / archived 禁止 / storage.delete 失敗でも DB 削除後に成功
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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

vi.mock("@/lib/prisma", () => ({
  default: {
    fieldSurveyPin: { findUnique: vi.fn() },
    fieldSurveyPinPhoto: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      aggregate: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

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
  });
}

function jpeg(bytes = 16): Blob {
  return new Blob([new Uint8Array(bytes)], { type: "image/jpeg" });
}

beforeEach(() => {
  vi.clearAllMocks();
  storageStub.upload.mockResolvedValue({
    url: `/uploads/field-survey/pins/${PIN_ID}/photos/1.jpg`,
    key: `field-survey/pins/${PIN_ID}/photos/1.jpg`,
  });
  storageStub.delete.mockResolvedValue(undefined);
  (prisma.fieldSurveyPinPhoto.aggregate as ReturnType<typeof vi.fn>).mockResolvedValue({
    _max: { sortOrder: null },
  });
});

describe("POST photos", () => {
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
    });
    const res = await POST(req, paramsP(PIN_ID));
    expect(res.status).toBe(422);
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
    const res = await GET(new Request("http://t"), paramsP(PIN_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toMatch(/storageKey/);
    expect(body.data[0].fileUrl).toMatch(/^\/uploads\//);
  });

  it("他人 pin は read_all で閲覧可", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue(OWNER);
    (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(readAllPerms);
    (prisma.fieldSurveyPin.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: PIN_ID,
      staffUserId: OTHER.id,
    });
    (prisma.fieldSurveyPinPhoto.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const res = await GET(new Request("http://t"), paramsP(PIN_ID));
    expect(res.status).toBe(200);
  });

  it("他人 pin を read のみで閲覧は 403", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue(OWNER);
    (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(readOnlyPerms);
    (prisma.fieldSurveyPin.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: PIN_ID,
      staffUserId: OTHER.id,
    });
    const res = await GET(new Request("http://t"), paramsP(PIN_ID));
    expect(res.status).toBe(403);
  });

  it("read 権限なしは 403", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue(OWNER);
    (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(noPerms);
    const res = await GET(new Request("http://t"), paramsP(PIN_ID));
    expect(res.status).toBe(403);
  });
});

describe("DELETE photo", () => {
  function mockPhoto(staffUserId: string, status = "open") {
    (prisma.fieldSurveyPinPhoto.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: PHOTO_ID,
      pinId: PIN_ID,
      fileUrl: `/uploads/field-survey/pins/${PIN_ID}/photos/1.jpg`,
      pin: { staffUserId, status },
    });
    (prisma.fieldSurveyPinPhoto.delete as ReturnType<typeof vi.fn>).mockResolvedValue({});
  }

  it("own pin 写真を削除し storage.delete も呼ぶ", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue(OWNER);
    (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(writePerms);
    mockPhoto(OWNER.id);
    const res = await DELETE(new Request("http://t"), paramsDel(PIN_ID, PHOTO_ID));
    expect(res.status).toBe(200);
    expect(prisma.fieldSurveyPinPhoto.delete).toHaveBeenCalledTimes(1);
    expect(storageStub.delete).toHaveBeenCalledTimes(1);
    const detail = (writeAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0].detail;
    expect(detail).toEqual({ pinId: PIN_ID, photoId: PHOTO_ID });
  });

  it("他人 pin の写真削除は 403", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue(OWNER);
    (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue([
      ...writePerms,
      { resource: "field_survey", action: "manage", granted: true },
    ]);
    mockPhoto(OTHER.id);
    const res = await DELETE(new Request("http://t"), paramsDel(PIN_ID, PHOTO_ID));
    expect(res.status).toBe(403);
    expect(prisma.fieldSurveyPinPhoto.delete).not.toHaveBeenCalled();
  });

  it("archived pin の写真削除は 409", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue(OWNER);
    (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(writePerms);
    mockPhoto(OWNER.id, "archived");
    const res = await DELETE(new Request("http://t"), paramsDel(PIN_ID, PHOTO_ID));
    expect(res.status).toBe(409);
    expect(prisma.fieldSurveyPinPhoto.delete).not.toHaveBeenCalled();
  });

  it("storage.delete 失敗でも DB 削除後に API は成功する", async () => {
    (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue(OWNER);
    (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(writePerms);
    mockPhoto(OWNER.id);
    storageStub.delete.mockRejectedValueOnce(new Error("network"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await DELETE(new Request("http://t"), paramsDel(PIN_ID, PHOTO_ID));
    expect(res.status).toBe(200);
    expect(prisma.fieldSurveyPinPhoto.delete).toHaveBeenCalledTimes(1);
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });
});
