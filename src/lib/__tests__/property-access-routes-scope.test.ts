/**
 * canAccessPropertyRecord へ統一した後の field_staff スコープ挙動を route で検証。
 * 対象: photos GET / attachments[attachmentId] DELETE。
 * 特に attachment.property=null のとき field_staff が許可される
 * （旧 inline の `&& attachment.property` と同等＝null は判定対象外）ことを固定する。
 *
 * permissions / property-access は実物。prisma / api-helpers / audit / storage は mock。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type { ApiSession, PermissionEntry } from "@/lib/api-helpers";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
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
    apiResponse: vi.fn((data: unknown, status = 200) =>
      Response.json(data, { status }),
    ),
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
  };
});

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/storage", () => ({
  getStorage: vi.fn(),
  validateFile: vi.fn(),
  ALLOWED_PHOTO_MIMES: [] as string[],
}));
vi.mock("@/lib/url-normalize", () => ({
  normalizeFileUrlsInRecord: (r: unknown) => r,
}));
vi.mock("@/lib/prisma", () => ({
  default: {
    property: { findUnique: vi.fn() },
    propertyPhoto: { findMany: vi.fn() },
    attachment: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { GET as photosGET } from "../../app/api/properties/[id]/photos/route";
import { DELETE as attachmentDelete } from "../../app/api/properties/[id]/attachments/[attachmentId]/route";

const PROP = "11111111-1111-4111-8111-111111111111";
const ATT = "22222222-2222-4222-8222-222222222222";
const STAFF = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";

const p = prisma as unknown as {
  property: { findUnique: Mock };
  propertyPhoto: { findMany: Mock };
  attachment: { findUnique: Mock; update: Mock };
};
const sessionMock = getApiSession as unknown as Mock;
const permsMock = getUserPermissions as unknown as Mock;

const PERMS: PermissionEntry[] = [
  { resource: "property", action: "read", granted: true },
  { resource: "property", action: "write", granted: true },
];

function session(role: string, id = STAFF): ApiSession {
  return { id, email: "u@e.com", name: "U", role } as ApiSession;
}
function photoCtx() {
  return { params: Promise.resolve({ id: PROP }) };
}
function attCtx() {
  return { params: Promise.resolve({ id: PROP, attachmentId: ATT }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  permsMock.mockResolvedValue(PERMS);
  p.propertyPhoto.findMany.mockResolvedValue([]);
  p.attachment.update.mockResolvedValue({});
});

describe("photos GET — field_staff スコープ（canAccessPropertyRecord）", () => {
  it("field_staff・担当外 → 403（一覧を引かない）", async () => {
    sessionMock.mockResolvedValue(session("field_staff"));
    p.property.findUnique.mockResolvedValue({
      id: PROP,
      createdBy: OTHER,
      assignedTo: OTHER,
    });
    const res = await photosGET(new Request("http://t/") as never, photoCtx());
    expect(res.status).toBe(403);
    expect(p.propertyPhoto.findMany).not.toHaveBeenCalled();
  });
  it("field_staff・creator → 200", async () => {
    sessionMock.mockResolvedValue(session("field_staff"));
    p.property.findUnique.mockResolvedValue({
      id: PROP,
      createdBy: STAFF,
      assignedTo: OTHER,
    });
    const res = await photosGET(new Request("http://t/") as never, photoCtx());
    expect(res.status).toBe(200);
  });
  it("admin → 担当外でも 200", async () => {
    sessionMock.mockResolvedValue(session("admin", OTHER));
    p.property.findUnique.mockResolvedValue({
      id: PROP,
      createdBy: STAFF,
      assignedTo: STAFF,
    });
    const res = await photosGET(new Request("http://t/") as never, photoCtx());
    expect(res.status).toBe(200);
  });
});

describe("attachments[attachmentId] DELETE — field_staff スコープ + null property", () => {
  function att(
    property: { createdBy: string; assignedTo: string | null } | null,
  ) {
    return {
      id: ATT,
      targetId: PROP,
      isDeleted: false,
      fileName: "f.pdf",
      property,
    };
  }
  it("field_staff・担当外 → 403（update しない）", async () => {
    sessionMock.mockResolvedValue(session("field_staff"));
    p.attachment.findUnique.mockResolvedValue(
      att({ createdBy: OTHER, assignedTo: OTHER }),
    );
    const res = await attachmentDelete(
      new Request("http://t/", { method: "DELETE" }) as never,
      attCtx(),
    );
    expect(res.status).toBe(403);
    expect(p.attachment.update).not.toHaveBeenCalled();
  });
  it("field_staff・assignee → 200（soft-delete）", async () => {
    sessionMock.mockResolvedValue(session("field_staff"));
    p.attachment.findUnique.mockResolvedValue(
      att({ createdBy: OTHER, assignedTo: STAFF }),
    );
    const res = await attachmentDelete(
      new Request("http://t/", { method: "DELETE" }) as never,
      attCtx(),
    );
    expect(res.status).toBe(200);
    expect(p.attachment.update).toHaveBeenCalled();
  });
  it("field_staff・property=null → 200（旧 inline の && property と等価＝許可）", async () => {
    sessionMock.mockResolvedValue(session("field_staff"));
    p.attachment.findUnique.mockResolvedValue(att(null));
    const res = await attachmentDelete(
      new Request("http://t/", { method: "DELETE" }) as never,
      attCtx(),
    );
    expect(res.status).toBe(200);
  });
});
