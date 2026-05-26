/**
 * /api/field-survey/sessions route tests (Phase 1-A).
 *
 * 検証ポイント:
 *  - 権限境界 (field_survey:write / read / read_all / manage)
 *  - field_staff が他人 session を終了できない
 *  - active session 重複時 409
 *  - AuditLog detail に lat/lng 等 PII / 位置データを入れない
 *  - 強制 own scope: read_all 不所持時の staffUserId 指定無視
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

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
      if (
        error &&
        typeof error === "object" &&
        "issues" in error &&
        Array.isArray((error as { issues: unknown[] }).issues)
      ) {
        return Response.json(
          { error: { message: "validation", code: "VALIDATION_ERROR" } },
          { status: 422 },
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

vi.mock("@/lib/prisma", () => ({
  default: {
    fieldSurveySession: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
} from "@/lib/api-helpers";
import { POST, GET } from "@/app/api/field-survey/sessions/route";
import { PATCH } from "@/app/api/field-survey/sessions/[id]/route";

const fieldUser = { id: "u-field", email: "f@x", name: "F", role: "field_staff" };
const officeUser = { id: "u-office", email: "o@x", name: "O", role: "office_staff" };
const adminUser = { id: "u-admin", email: "a@x", name: "A", role: "admin" };

const fieldPerms = [
  { resource: "field_survey", action: "read", granted: true },
  { resource: "field_survey", action: "write", granted: true },
];
const officePerms = [
  { resource: "field_survey", action: "read", granted: true },
  { resource: "field_survey", action: "read_all", granted: true },
];
const adminPerms = [
  { resource: "field_survey", action: "read", granted: true },
  { resource: "field_survey", action: "write", granted: true },
  { resource: "field_survey", action: "read_all", granted: true },
  { resource: "field_survey", action: "manage", granted: true },
];

beforeEach(() => {
  vi.clearAllMocks();
});

function makeReq(url: string, init?: RequestInit) {
  return new Request(url, init) as unknown as import("next/server").NextRequest;
}

// ============================================================
// POST /api/field-survey/sessions
// ============================================================
describe("POST /api/field-survey/sessions", () => {
  it("未ログインは 401", async () => {
    (getApiSession as Mock).mockRejectedValueOnce(
      new ApiError(401, "認証が必要です", "UNAUTHORIZED"),
    );
    const res = await POST(
      makeReq("http://x/api/field-survey/sessions", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("field_survey:write 不所持は 403", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue([
      { resource: "field_survey", action: "read", granted: true },
    ]);
    const res = await POST(
      makeReq("http://x/api/field-survey/sessions", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("active session 重複時は 409", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveySession.findFirst as Mock).mockResolvedValue({
      id: "s-active",
    });
    const res = await POST(
      makeReq("http://x/api/field-survey/sessions", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(res.status).toBe(409);
    expect(prisma.fieldSurveySession.create).not.toHaveBeenCalled();
  });

  it("正常時 201 + AuditLog 書き込み (detail に座標を含まない)", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveySession.findFirst as Mock).mockResolvedValue(null);
    (prisma.fieldSurveySession.create as Mock).mockResolvedValue({
      id: "s-1",
      staffUserId: fieldUser.id,
      startedAt: new Date(),
      endedAt: null,
      status: "active",
      memo: null,
      pointCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await POST(
      makeReq("http://x/api/field-survey/sessions", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(res.status).toBe(201);
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    const call = writeAuditLog.mock.calls[0][0];
    expect(call.action).toBe("field_survey_session_start");
    expect(call.detail).toEqual({ sessionId: "s-1" });
    // PII / 位置情報を含めないことを明示的に確認
    const serialized = JSON.stringify(call.detail);
    expect(serialized).not.toMatch(/lat/i);
    expect(serialized).not.toMatch(/lng/i);
    expect(serialized).not.toMatch(/longitude/i);
    expect(serialized).not.toMatch(/latitude/i);
  });

  it("memo 長すぎは 422", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    const res = await POST(
      makeReq("http://x/api/field-survey/sessions", {
        method: "POST",
        body: JSON.stringify({ memo: "x".repeat(2001) }),
      }),
    );
    expect(res.status).toBe(422);
  });
});

// ============================================================
// GET /api/field-survey/sessions
// ============================================================
describe("GET /api/field-survey/sessions", () => {
  it("read 不所持は 403", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue([]);
    const res = await GET(
      makeReq("http://x/api/field-survey/sessions"),
    );
    expect(res.status).toBe(403);
  });

  it("read_all 不所持は 他人 staffUserId 指定を無視して own のみ", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveySession.count as Mock).mockResolvedValue(0);
    (prisma.fieldSurveySession.findMany as Mock).mockResolvedValue([]);
    const url =
      "http://x/api/field-survey/sessions?staffUserId=11111111-1111-4111-8111-111111111111";
    await GET(makeReq(url));
    const where = (prisma.fieldSurveySession.findMany as Mock).mock.calls[0][0]
      .where;
    expect(where.staffUserId).toBe(fieldUser.id);
  });

  it("read_all 所持は staffUserId 指定を採用", async () => {
    (getApiSession as Mock).mockResolvedValue(officeUser);
    (getUserPermissions as Mock).mockResolvedValue(officePerms);
    (prisma.fieldSurveySession.count as Mock).mockResolvedValue(0);
    (prisma.fieldSurveySession.findMany as Mock).mockResolvedValue([]);
    const target = "22222222-2222-4222-8222-222222222222";
    await GET(
      makeReq(`http://x/api/field-survey/sessions?staffUserId=${target}`),
    );
    const where = (prisma.fieldSurveySession.findMany as Mock).mock.calls[0][0]
      .where;
    expect(where.staffUserId).toBe(target);
  });

  it("pagination が反映される (skip/take)", async () => {
    (getApiSession as Mock).mockResolvedValue(adminUser);
    (getUserPermissions as Mock).mockResolvedValue(adminPerms);
    (prisma.fieldSurveySession.count as Mock).mockResolvedValue(120);
    (prisma.fieldSurveySession.findMany as Mock).mockResolvedValue([]);
    await GET(
      makeReq("http://x/api/field-survey/sessions?page=2&limit=20"),
    );
    const args = (prisma.fieldSurveySession.findMany as Mock).mock.calls[0][0];
    expect(args.skip).toBe(20);
    expect(args.take).toBe(20);
  });
});

// ============================================================
// PATCH /api/field-survey/sessions/[id]
// ============================================================
describe("PATCH /api/field-survey/sessions/[id]", () => {
  const params = Promise.resolve({ id: "s-1" });

  it("write 不所持は 403", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue([
      { resource: "field_survey", action: "read", granted: true },
    ]);
    const res = await PATCH(
      makeReq("http://x/api/field-survey/sessions/s-1", {
        method: "PATCH",
        body: JSON.stringify({ status: "ended" }),
      }),
      { params },
    );
    expect(res.status).toBe(403);
  });

  it("session 未存在は 404", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveySession.findUnique as Mock).mockResolvedValue(null);
    const res = await PATCH(
      makeReq("http://x/api/field-survey/sessions/s-1", {
        method: "PATCH",
        body: JSON.stringify({ status: "ended" }),
      }),
      { params },
    );
    expect(res.status).toBe(404);
  });

  it("field_staff が他人 session の終了は 403", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveySession.findUnique as Mock).mockResolvedValue({
      id: "s-1",
      staffUserId: "other-user",
      startedAt: new Date(),
      endedAt: null,
      status: "active",
      pointCount: 0,
    });
    const res = await PATCH(
      makeReq("http://x/api/field-survey/sessions/s-1", {
        method: "PATCH",
        body: JSON.stringify({ status: "ended" }),
      }),
      { params },
    );
    expect(res.status).toBe(403);
    expect(prisma.fieldSurveySession.update).not.toHaveBeenCalled();
  });

  it("admin (manage) は他人 session を終了できる", async () => {
    (getApiSession as Mock).mockResolvedValue(adminUser);
    (getUserPermissions as Mock).mockResolvedValue(adminPerms);
    const startedAt = new Date(Date.now() - 60_000);
    (prisma.fieldSurveySession.findUnique as Mock).mockResolvedValue({
      id: "s-1",
      staffUserId: "other-user",
      startedAt,
      endedAt: null,
      status: "active",
      pointCount: 42,
    });
    (prisma.fieldSurveySession.update as Mock).mockResolvedValue({
      id: "s-1",
      staffUserId: "other-user",
      startedAt,
      endedAt: new Date(),
      status: "ended",
      memo: null,
      pointCount: 42,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await PATCH(
      makeReq("http://x/api/field-survey/sessions/s-1", {
        method: "PATCH",
        body: JSON.stringify({ status: "ended" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    const call = writeAuditLog.mock.calls[0][0];
    expect(call.action).toBe("field_survey_session_end");
    expect(call.detail.sessionId).toBe("s-1");
    expect(call.detail.pointCount).toBe(42);
    expect(typeof call.detail.durationSec).toBe("number");
    // 位置情報を含めない
    const s = JSON.stringify(call.detail);
    expect(s).not.toMatch(/lat/i);
    expect(s).not.toMatch(/lng/i);
  });

  it("active でない session への終了要求は 409", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveySession.findUnique as Mock).mockResolvedValue({
      id: "s-1",
      staffUserId: fieldUser.id,
      startedAt: new Date(),
      endedAt: new Date(),
      status: "ended",
      pointCount: 0,
    });
    const res = await PATCH(
      makeReq("http://x/api/field-survey/sessions/s-1", {
        method: "PATCH",
        body: JSON.stringify({ status: "ended" }),
      }),
      { params },
    );
    expect(res.status).toBe(409);
  });

  it("cancel 時の AuditLog detail に位置情報を含まない", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveySession.findUnique as Mock).mockResolvedValue({
      id: "s-1",
      staffUserId: fieldUser.id,
      startedAt: new Date(),
      endedAt: null,
      status: "active",
      pointCount: 0,
    });
    (prisma.fieldSurveySession.update as Mock).mockResolvedValue({
      id: "s-1",
      staffUserId: fieldUser.id,
      startedAt: new Date(),
      endedAt: new Date(),
      status: "cancelled",
      memo: null,
      pointCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await PATCH(
      makeReq("http://x/api/field-survey/sessions/s-1", {
        method: "PATCH",
        body: JSON.stringify({ status: "cancelled" }),
      }),
      { params },
    );
    const call = writeAuditLog.mock.calls[0][0];
    expect(call.action).toBe("field_survey_session_cancel");
    expect(call.detail).toEqual({ sessionId: "s-1" });
  });

  it("memo のみ更新は AuditLog を書かない", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveySession.findUnique as Mock).mockResolvedValue({
      id: "s-1",
      staffUserId: fieldUser.id,
      startedAt: new Date(),
      endedAt: null,
      status: "active",
      pointCount: 0,
    });
    (prisma.fieldSurveySession.update as Mock).mockResolvedValue({
      id: "s-1",
      staffUserId: fieldUser.id,
      startedAt: new Date(),
      endedAt: null,
      status: "active",
      memo: "updated",
      pointCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await PATCH(
      makeReq("http://x/api/field-survey/sessions/s-1", {
        method: "PATCH",
        body: JSON.stringify({ memo: "updated" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("status / memo どちらも空は 422", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    const res = await PATCH(
      makeReq("http://x/api/field-survey/sessions/s-1", {
        method: "PATCH",
        body: JSON.stringify({}),
      }),
      { params },
    );
    expect(res.status).toBe(422);
  });
});
