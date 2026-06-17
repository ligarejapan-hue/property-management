/**
 * GET/POST /api/properties/[id]/attachments の field_staff スコープ統合テスト。
 *
 * scope 統一: 旧 inline 判定（field_staff && createdBy≠id && assignedTo≠id）を、
 * 物件詳細 API と同一判定の共有ヘルパ canAccessPropertyRecord へ委譲した後の
 * アクセス挙動をロックする（挙動不変の refactor を回帰検出するため）。
 *
 * permissions（hasPermission）と property-access（canAccessPropertyRecord）は実物。
 * prisma / api-helpers / audit / storage / url-normalize は mock。
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
  ALLOWED_ATTACHMENT_MIMES: [] as string[],
}));
vi.mock("@/lib/url-normalize", () => ({
  normalizeFileUrlsInRecord: (r: unknown) => r,
}));
vi.mock("@/lib/prisma", () => ({
  default: {
    property: { findUnique: vi.fn() },
    attachment: { findMany: vi.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { GET, POST } from "../../app/api/properties/[id]/attachments/route";

const PROPERTY_ID = "11111111-1111-4111-8111-111111111111";
const STAFF_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";

const prismaMock = prisma as unknown as {
  property: { findUnique: Mock };
  attachment: { findMany: Mock };
};
const getApiSessionMock = getApiSession as unknown as Mock;
const getUserPermissionsMock = getUserPermissions as unknown as Mock;

const ALL_PERMS: PermissionEntry[] = [
  { resource: "property", action: "read", granted: true },
  { resource: "property", action: "write", granted: true },
];

function session(role: string, id = STAFF_ID): ApiSession {
  return { id, email: "u@example.com", name: "U", role } as ApiSession;
}
function ctx() {
  return { params: Promise.resolve({ id: PROPERTY_ID }) };
}
function prop(createdBy: string, assignedTo: string | null) {
  return { id: PROPERTY_ID, createdBy, assignedTo };
}

beforeEach(() => {
  vi.clearAllMocks();
  getUserPermissionsMock.mockResolvedValue(ALL_PERMS);
  prismaMock.attachment.findMany.mockResolvedValue([]);
});

describe("GET attachments — field_staff スコープ（canAccessPropertyRecord 委譲）", () => {
  it("field_staff・担当外（creator でも assignee でもない）→ 403・一覧を引かない", async () => {
    getApiSessionMock.mockResolvedValue(session("field_staff"));
    prismaMock.property.findUnique.mockResolvedValue(prop(OTHER_ID, OTHER_ID));
    const res = await GET(new Request("http://t/") as never, ctx());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.message).toBe("この物件を閲覧する権限がありません");
    expect(prismaMock.attachment.findMany).not.toHaveBeenCalled();
  });

  it("field_staff・creator → 200", async () => {
    getApiSessionMock.mockResolvedValue(session("field_staff"));
    prismaMock.property.findUnique.mockResolvedValue(prop(STAFF_ID, OTHER_ID));
    const res = await GET(new Request("http://t/") as never, ctx());
    expect(res.status).toBe(200);
  });

  it("field_staff・assignee → 200", async () => {
    getApiSessionMock.mockResolvedValue(session("field_staff"));
    prismaMock.property.findUnique.mockResolvedValue(prop(OTHER_ID, STAFF_ID));
    const res = await GET(new Request("http://t/") as never, ctx());
    expect(res.status).toBe(200);
  });

  it("admin → 担当外でも 200", async () => {
    getApiSessionMock.mockResolvedValue(session("admin", OTHER_ID));
    prismaMock.property.findUnique.mockResolvedValue(prop(STAFF_ID, STAFF_ID));
    const res = await GET(new Request("http://t/") as never, ctx());
    expect(res.status).toBe(200);
  });

  it("物件なし → 404", async () => {
    getApiSessionMock.mockResolvedValue(session("field_staff"));
    prismaMock.property.findUnique.mockResolvedValue(null);
    const res = await GET(new Request("http://t/") as never, ctx());
    expect(res.status).toBe(404);
  });
});

describe("POST attachments — field_staff スコープ（write・body 解析前に拒否）", () => {
  it("field_staff・担当外 → 403（編集権限）", async () => {
    getApiSessionMock.mockResolvedValue(session("field_staff"));
    prismaMock.property.findUnique.mockResolvedValue(prop(OTHER_ID, OTHER_ID));
    const res = await POST(
      new Request("http://t/", { method: "POST" }) as never,
      ctx(),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.message).toBe("この物件を編集する権限がありません");
  });
});
