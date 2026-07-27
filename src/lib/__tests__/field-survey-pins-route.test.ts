/**
 * /api/field-survey/pins route tests (Phase 1-C).
 *
 * 検証ポイント:
 *  - POST: 認可 / sessionId・propertyId 認可 / staffUserId 拒否 / lat/lng 範囲 /
 *    pinType allowlist / ended session 409 / AuditLog 座標非含有
 *  - GET list: own / read_all / archived デフォルト除外 / pagination / 他人 staffUserId
 *    フィルタ時のみ AuditLog
 *  - GET detail: own / 他人 read_all / 他人時のみ AuditLog
 *  - PATCH: own / 他人 manage / read_all のみは更新不可 / lat 拒否 / propertyId 解除
 *    / AuditLog 座標非含有
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
    parseJsonBody: vi.fn(async (request: Request) => {
      const text = await request.text();
      if (text.trim() === "") return {};
      try {
        return JSON.parse(text);
      } catch {
        throw new MockApiError(
          400,
          "リクエストボディが不正な JSON です",
          "INVALID_JSON",
        );
      }
    }),
  };
});

const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));

vi.mock("@/lib/prisma", () => {
  const client: Record<string, unknown> = {
    fieldSurveyPin: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    fieldSurveyPinPhoto: {
      delete: vi.fn(),
      deleteMany: vi.fn(),
      findMany: vi.fn(),
    },
    fieldSurveySession: {
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    property: {
      findUnique: vi.fn(),
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
import { POST, GET as LIST } from "@/app/api/field-survey/pins/route";
import {
  GET as DETAIL,
  PATCH,
  DELETE,
} from "@/app/api/field-survey/pins/[id]/route";

const fieldUser = { id: "u-field", email: "f@x", name: "F", role: "field_staff" };
const officeUser = {
  id: "u-office",
  email: "o@x",
  name: "O",
  role: "office_staff",
};
const adminUser = { id: "u-admin", email: "a@x", name: "A", role: "admin" };

const fieldPerms = [
  { resource: "field_survey", action: "read", granted: true },
  { resource: "field_survey", action: "write", granted: true },
  { resource: "property", action: "read", granted: true },
];
// 巡回なし撮影 (sessionId を送らない pin 作成) を許可された担当者。
// 既定テンプレートには付かない権限なので、fieldPerms とは別に用意する。
const quickCapturePerms = [
  ...fieldPerms,
  { resource: "field_survey", action: "quick_capture", granted: true },
];
const officePerms = [
  { resource: "field_survey", action: "read", granted: true },
  { resource: "field_survey", action: "read_all", granted: true },
  { resource: "property", action: "read", granted: true },
];
const adminPerms = [
  { resource: "field_survey", action: "read", granted: true },
  { resource: "field_survey", action: "write", granted: true },
  { resource: "field_survey", action: "read_all", granted: true },
  { resource: "field_survey", action: "manage", granted: true },
  { resource: "property", action: "read", granted: true },
];

beforeEach(() => {
  vi.clearAllMocks();
});

function makeReq(url: string, init?: RequestInit) {
  return new Request(url, init) as unknown as import("next/server").NextRequest;
}

const PIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROPERTY_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const baseLat = 35.6812;
const baseLng = 139.7671;

// ============================================================
// POST /api/field-survey/pins
// ============================================================
describe("POST /api/field-survey/pins", () => {
  it("write 不所持は 403 / DB に到達しない", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue([
      { resource: "field_survey", action: "read", granted: true },
    ]);
    const res = await POST(
      makeReq("http://x/api/field-survey/pins", {
        method: "POST",
        body: JSON.stringify({ lat: baseLat, lng: baseLng, pinType: "candidate" }),
      }),
    );
    expect(res.status).toBe(403);
    expect(prisma.fieldSurveyPin.create).not.toHaveBeenCalled();
  });

  it("malformed JSON は 400", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    const res = await POST(
      makeReq("http://x/api/field-survey/pins", {
        method: "POST",
        body: "{ broken",
      }),
    );
    expect(res.status).toBe(400);
    expect(prisma.fieldSurveyPin.create).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("lat 範囲外は 422", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    const res = await POST(
      makeReq("http://x/api/field-survey/pins", {
        method: "POST",
        body: JSON.stringify({ lat: 91, lng: 0, pinType: "candidate" }),
      }),
    );
    expect(res.status).toBe(422);
  });

  it("invalid pinType は 422", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    const res = await POST(
      makeReq("http://x/api/field-survey/pins", {
        method: "POST",
        body: JSON.stringify({ lat: baseLat, lng: baseLng, pinType: "unknown" }),
      }),
    );
    expect(res.status).toBe(422);
  });

  it("staffUserId を body で送ると strict() で 422 拒否", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    const res = await POST(
      makeReq("http://x/api/field-survey/pins", {
        method: "POST",
        body: JSON.stringify({
          lat: baseLat,
          lng: baseLng,
          pinType: "candidate",
          staffUserId: "evil-user",
        }),
      }),
    );
    expect(res.status).toBe(422);
    expect(prisma.fieldSurveyPin.create).not.toHaveBeenCalled();
  });

  it("正常時: own pin を作成 + 201 + AuditLog (座標非含有)", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(quickCapturePerms);
    (prisma.fieldSurveyPin.create as Mock).mockResolvedValue({
      id: PIN_ID,
      sessionId: null,
      staffUserId: fieldUser.id,
      propertyId: null,
      lat: baseLat,
      lng: baseLng,
      accuracy: null,
      pinType: "candidate",
      status: "open",
      memo: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await POST(
      makeReq("http://x/api/field-survey/pins", {
        method: "POST",
        body: JSON.stringify({
          lat: baseLat,
          lng: baseLng,
          pinType: "candidate",
          memo: "private memo content",
        }),
      }),
    );
    expect(res.status).toBe(201);
    // staffUserId は body 由来ではなく session.id 固定
    const createArgs = (prisma.fieldSurveyPin.create as Mock).mock.calls[0][0];
    expect(createArgs.data.staffUserId).toBe(fieldUser.id);
    // AuditLog detail に座標 / memo 本文を含めない
    const call = writeAuditLog.mock.calls[0][0];
    expect(call.action).toBe("field_survey_pin_create");
    expect(call.detail).toEqual({
      pinId: PIN_ID,
      pinType: "candidate",
      status: "open",
      hasSession: false,
      hasProperty: false,
    });
    const s = JSON.stringify(call.detail);
    expect(s).not.toMatch(/lat/i);
    expect(s).not.toMatch(/lng/i);
    expect(s).not.toMatch(/accuracy/i);
    expect(s).not.toMatch(/private memo content/);
  });

  it("sessionId 指定: 他人 session は 403", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveySession.findUnique as Mock).mockResolvedValue({
      staffUserId: "other-user",
      status: "active",
    });
    const res = await POST(
      makeReq("http://x/api/field-survey/pins", {
        method: "POST",
        body: JSON.stringify({
          lat: baseLat,
          lng: baseLng,
          pinType: "candidate",
          sessionId: SESSION_ID,
        }),
      }),
    );
    expect(res.status).toBe(403);
    expect(prisma.fieldSurveyPin.create).not.toHaveBeenCalled();
  });

  it("sessionId 指定: admin (manage) でも他スタッフ session には紐付けられない (P1-1)", async () => {
    (getApiSession as Mock).mockResolvedValue(adminUser);
    (getUserPermissions as Mock).mockResolvedValue(adminPerms);
    (prisma.fieldSurveySession.findUnique as Mock).mockResolvedValue({
      staffUserId: "other-user",
      status: "active",
    });
    const res = await POST(
      makeReq("http://x/api/field-survey/pins", {
        method: "POST",
        body: JSON.stringify({
          lat: baseLat,
          lng: baseLng,
          pinType: "candidate",
          sessionId: SESSION_ID,
        }),
      }),
    );
    expect(res.status).toBe(403);
    expect(prisma.fieldSurveyPin.create).not.toHaveBeenCalled();
  });

  it("sessionId 指定: 自分の active session には紐付け可 (own session)", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveySession.findUnique as Mock).mockResolvedValue({
      staffUserId: fieldUser.id,
      status: "active",
    });
    (prisma.fieldSurveyPin.create as Mock).mockResolvedValue({
      id: PIN_ID,
      sessionId: SESSION_ID,
      staffUserId: fieldUser.id,
      propertyId: null,
      lat: baseLat,
      lng: baseLng,
      accuracy: null,
      pinType: "candidate",
      status: "open",
      memo: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await POST(
      makeReq("http://x/api/field-survey/pins", {
        method: "POST",
        body: JSON.stringify({
          lat: baseLat,
          lng: baseLng,
          pinType: "candidate",
          sessionId: SESSION_ID,
        }),
      }),
    );
    expect(res.status).toBe(201);
    // pin.staffUserId === session.staffUserId が保たれる
    const createArgs = (prisma.fieldSurveyPin.create as Mock).mock.calls[0][0];
    expect(createArgs.data.staffUserId).toBe(fieldUser.id);
    expect(createArgs.data.sessionId).toBe(SESSION_ID);
    // B-7(@codex #308): ピン作成は巡回の活動として session の最終活動時刻を更新
    // (active 条件付き = 並行終了後は no-op)
    const touchArgs = (prisma.fieldSurveySession.updateMany as Mock).mock
      .calls[0][0];
    expect(touchArgs.where).toEqual({ id: SESSION_ID, status: "active" });
    expect(touchArgs.data.updatedAt).toBeInstanceOf(Date);
  });

  it("B-7(@codex R8): 事前チェック後に session が並行終了していたら 409 で pin 作成ごと rollback", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveySession.findUnique as Mock).mockResolvedValue({
      staffUserId: fieldUser.id,
      status: "active",
    });
    (prisma.fieldSurveyPin.create as Mock).mockResolvedValue({
      id: PIN_ID,
      sessionId: SESSION_ID,
      staffUserId: fieldUser.id,
      propertyId: null,
      lat: baseLat,
      lng: baseLng,
      accuracy: null,
      pinType: "candidate",
      status: "open",
      memo: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // touch が 0 行 = 事前チェック後に並行で auto-end された
    (prisma.fieldSurveySession.updateMany as Mock).mockResolvedValueOnce({
      count: 0,
    });
    const res = await POST(
      makeReq("http://x/api/field-survey/pins", {
        method: "POST",
        body: JSON.stringify({
          lat: baseLat,
          lng: baseLng,
          pinType: "candidate",
          sessionId: SESSION_ID,
        }),
      }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_STATE");
    // rollback 前提のため成功系の監査ログは書かない
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("sessionId 無しの pin 作成では session を触らない", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(quickCapturePerms);
    (prisma.fieldSurveyPin.create as Mock).mockResolvedValue({
      id: PIN_ID,
      sessionId: null,
      staffUserId: fieldUser.id,
      propertyId: null,
      lat: baseLat,
      lng: baseLng,
      accuracy: null,
      pinType: "candidate",
      status: "open",
      memo: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await POST(
      makeReq("http://x/api/field-survey/pins", {
        method: "POST",
        body: JSON.stringify({
          lat: baseLat,
          lng: baseLng,
          pinType: "candidate",
        }),
      }),
    );
    expect(res.status).toBe(201);
    expect(prisma.fieldSurveySession.updateMany).not.toHaveBeenCalled();
  });

  // 巡回なし撮影 (field_survey:quick_capture) の fail-closed ゲート。
  // 巡回外の pin は移動軌跡が残らず巡回履歴にも出ないため、write だけでは作れない。
  it("quick_capture が無いと sessionId 無しの作成は 403 (DB に触れない)", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    const res = await POST(
      makeReq("http://x/api/field-survey/pins", {
        method: "POST",
        body: JSON.stringify({
          lat: baseLat,
          lng: baseLng,
          pinType: "candidate",
        }),
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("QUICK_CAPTURE_FORBIDDEN");
    expect(prisma.fieldSurveyPin.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("quick_capture が無くても sessionId 付き (巡回中) の作成は従来どおり通る", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveySession.findUnique as Mock).mockResolvedValue({
      staffUserId: fieldUser.id,
      status: "active",
    });
    (prisma.fieldSurveySession.updateMany as Mock).mockResolvedValue({
      count: 1,
    });
    (prisma.fieldSurveyPin.create as Mock).mockResolvedValue({
      id: PIN_ID,
      sessionId: SESSION_ID,
      staffUserId: fieldUser.id,
      propertyId: null,
      lat: baseLat,
      lng: baseLng,
      accuracy: null,
      pinType: "candidate",
      status: "open",
      memo: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await POST(
      makeReq("http://x/api/field-survey/pins", {
        method: "POST",
        body: JSON.stringify({
          lat: baseLat,
          lng: baseLng,
          pinType: "candidate",
          sessionId: SESSION_ID,
        }),
      }),
    );
    expect(res.status).toBe(201);
  });

  it("sessionId 指定: ended session は 409", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveySession.findUnique as Mock).mockResolvedValue({
      staffUserId: fieldUser.id,
      status: "ended",
    });
    const res = await POST(
      makeReq("http://x/api/field-survey/pins", {
        method: "POST",
        body: JSON.stringify({
          lat: baseLat,
          lng: baseLng,
          pinType: "candidate",
          sessionId: SESSION_ID,
        }),
      }),
    );
    expect(res.status).toBe(409);
    expect(prisma.fieldSurveyPin.create).not.toHaveBeenCalled();
  });

  it("sessionId 指定: 未存在は 404", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveySession.findUnique as Mock).mockResolvedValue(null);
    const res = await POST(
      makeReq("http://x/api/field-survey/pins", {
        method: "POST",
        body: JSON.stringify({
          lat: baseLat,
          lng: baseLng,
          pinType: "candidate",
          sessionId: SESSION_ID,
        }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("propertyId 指定: 未存在は 404", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(quickCapturePerms);
    (prisma.property.findUnique as Mock).mockResolvedValue(null);
    const res = await POST(
      makeReq("http://x/api/field-survey/pins", {
        method: "POST",
        body: JSON.stringify({
          lat: baseLat,
          lng: baseLng,
          pinType: "candidate",
          propertyId: PROPERTY_ID,
        }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("propertyId 指定: field_staff が createdBy/assignedTo 非一致は 403", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.property.findUnique as Mock).mockResolvedValue({
      id: PROPERTY_ID,
      createdBy: "other-user",
      assignedTo: "yet-another",
    });
    const res = await POST(
      makeReq("http://x/api/field-survey/pins", {
        method: "POST",
        body: JSON.stringify({
          lat: baseLat,
          lng: baseLng,
          pinType: "candidate",
          propertyId: PROPERTY_ID,
        }),
      }),
    );
    expect(res.status).toBe(403);
    expect(prisma.fieldSurveyPin.create).not.toHaveBeenCalled();
  });

  it("propertyId 指定: own property に紐付け可", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(quickCapturePerms);
    (prisma.property.findUnique as Mock).mockResolvedValue({
      id: PROPERTY_ID,
      createdBy: fieldUser.id,
      assignedTo: null,
    });
    (prisma.fieldSurveyPin.create as Mock).mockResolvedValue({
      id: PIN_ID,
      sessionId: null,
      staffUserId: fieldUser.id,
      propertyId: PROPERTY_ID,
      lat: baseLat,
      lng: baseLng,
      accuracy: null,
      pinType: "candidate",
      status: "open",
      memo: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await POST(
      makeReq("http://x/api/field-survey/pins", {
        method: "POST",
        body: JSON.stringify({
          lat: baseLat,
          lng: baseLng,
          pinType: "candidate",
          propertyId: PROPERTY_ID,
        }),
      }),
    );
    expect(res.status).toBe(201);
    const call = writeAuditLog.mock.calls[0][0];
    expect(call.detail.hasProperty).toBe(true);
  });
});

// ============================================================
// GET /api/field-survey/pins (list)
// ============================================================
describe("GET /api/field-survey/pins (list)", () => {
  it("read 不所持は 403", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue([]);
    const res = await LIST(makeReq("http://x/api/field-survey/pins"));
    expect(res.status).toBe(403);
  });

  it("read のみ: own のみ取得・archived 除外", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveyPin.findMany as Mock).mockResolvedValue([]);
    await LIST(makeReq("http://x/api/field-survey/pins"));
    const args = (prisma.fieldSurveyPin.findMany as Mock).mock.calls[0][0];
    expect(args.where.staffUserId).toBe(fieldUser.id);
    expect(args.where.status).toEqual({ not: "archived" });
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("read のみ: 他人 staffUserId クエリは無視 → own 強制", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveyPin.findMany as Mock).mockResolvedValue([]);
    const other = "11111111-1111-4111-8111-111111111111";
    await LIST(makeReq(`http://x/api/field-survey/pins?staffUserId=${other}`));
    const args = (prisma.fieldSurveyPin.findMany as Mock).mock.calls[0][0];
    expect(args.where.staffUserId).toBe(fieldUser.id);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("read_all あり: staffUserId クエリで他人取得可 + 他人時のみ AuditLog", async () => {
    (getApiSession as Mock).mockResolvedValue(officeUser);
    (getUserPermissions as Mock).mockResolvedValue(officePerms);
    (prisma.fieldSurveyPin.findMany as Mock).mockResolvedValue([]);
    const other = "11111111-1111-4111-8111-111111111111";
    await LIST(makeReq(`http://x/api/field-survey/pins?staffUserId=${other}`));
    const args = (prisma.fieldSurveyPin.findMany as Mock).mock.calls[0][0];
    expect(args.where.staffUserId).toBe(other);
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    const call = writeAuditLog.mock.calls[0][0];
    expect(call.action).toBe("field_survey_pin_list_others");
    expect(call.detail.viewedStaffUserId).toBe(other);
    // 座標非含有
    const s = JSON.stringify(call.detail);
    expect(s).not.toMatch(/lat/i);
    expect(s).not.toMatch(/lng/i);
  });

  it("read_all あり: 自分の staffUserId 指定では AuditLog なし", async () => {
    (getApiSession as Mock).mockResolvedValue(officeUser);
    (getUserPermissions as Mock).mockResolvedValue(officePerms);
    (prisma.fieldSurveyPin.findMany as Mock).mockResolvedValue([]);
    await LIST(
      makeReq(`http://x/api/field-survey/pins?staffUserId=${officeUser.id}`),
    );
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("includeArchived=true で archived も含む", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveyPin.findMany as Mock).mockResolvedValue([]);
    await LIST(
      makeReq("http://x/api/field-survey/pins?includeArchived=true"),
    );
    const args = (prisma.fieldSurveyPin.findMany as Mock).mock.calls[0][0];
    expect(args.where.status).toBeUndefined();
  });

  it("status=archived 明示で archived のみ取得 (includeArchived より優先)", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveyPin.findMany as Mock).mockResolvedValue([]);
    await LIST(
      makeReq("http://x/api/field-survey/pins?status=archived"),
    );
    const args = (prisma.fieldSurveyPin.findMany as Mock).mock.calls[0][0];
    expect(args.where.status).toBe("archived");
  });

  it("cursor + limit が反映され nextCursor が返る", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveyPin.findMany as Mock).mockResolvedValue([
      { id: PIN_ID, sessionId: null, staffUserId: fieldUser.id, propertyId: null, lat: 0, lng: 0, accuracy: null, pinType: "candidate", status: "open", memo: null, createdAt: new Date(), updatedAt: new Date() },
      { id: "next", sessionId: null, staffUserId: fieldUser.id, propertyId: null, lat: 0, lng: 0, accuracy: null, pinType: "candidate", status: "open", memo: null, createdAt: new Date(), updatedAt: new Date() },
      { id: "extra", sessionId: null, staffUserId: fieldUser.id, propertyId: null, lat: 0, lng: 0, accuracy: null, pinType: "candidate", status: "open", memo: null, createdAt: new Date(), updatedAt: new Date() },
    ]);
    const cursorPrev = "11111111-1111-4111-8111-111111111111";
    const res = await LIST(
      makeReq(
        `http://x/api/field-survey/pins?cursor=${cursorPrev}&limit=2`,
      ),
    );
    const args = (prisma.fieldSurveyPin.findMany as Mock).mock.calls[0][0];
    expect(args.cursor).toEqual({ id: cursorPrev });
    expect(args.skip).toBe(1);
    expect(args.take).toBe(3); // limit + 1
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.nextCursor).toBe("next");
  });

  // --- Codex P2: bbox scope (Phase 1-E) -------------------------------------

  it("bbox 4 値指定で where に lat/lng range が積まれる", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveyPin.findMany as Mock).mockResolvedValue([]);
    await LIST(
      makeReq(
        "http://x/api/field-survey/pins?north=35.7&south=35.6&east=139.8&west=139.7",
      ),
    );
    const args = (prisma.fieldSurveyPin.findMany as Mock).mock.calls[0][0];
    expect(args.where.lat).toEqual({ gte: 35.6, lte: 35.7 });
    expect(args.where.lng).toEqual({ gte: 139.7, lte: 139.8 });
  });

  it("bbox 部分指定 (north のみ) は 422 / DB 未到達", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    const res = await LIST(
      makeReq("http://x/api/field-survey/pins?north=35.7"),
    );
    expect(res.status).toBe(422);
    expect(prisma.fieldSurveyPin.findMany).not.toHaveBeenCalled();
  });

  it("north < south は 422", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    const res = await LIST(
      makeReq(
        "http://x/api/field-survey/pins?north=35.5&south=35.7&east=139.8&west=139.7",
      ),
    );
    expect(res.status).toBe(422);
  });

  it("east < west は 422", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    const res = await LIST(
      makeReq(
        "http://x/api/field-survey/pins?north=35.7&south=35.6&east=139.7&west=139.8",
      ),
    );
    expect(res.status).toBe(422);
  });

  it("緯度差 > 0.5 度は 422", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    const res = await LIST(
      makeReq(
        "http://x/api/field-survey/pins?north=36.5&south=35.6&east=139.8&west=139.7",
      ),
    );
    expect(res.status).toBe(422);
  });

  it("経度差 > 0.5 度は 422", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    const res = await LIST(
      makeReq(
        "http://x/api/field-survey/pins?north=35.7&south=35.6&east=140.5&west=139.7",
      ),
    );
    expect(res.status).toBe(422);
  });

  it("bbox 無指定なら where に lat/lng 条件は積まれない (既存挙動維持)", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveyPin.findMany as Mock).mockResolvedValue([]);
    await LIST(makeReq("http://x/api/field-survey/pins"));
    const args = (prisma.fieldSurveyPin.findMany as Mock).mock.calls[0][0];
    expect(args.where.lat).toBeUndefined();
    expect(args.where.lng).toBeUndefined();
  });

  it("read_all + bbox 指定でも 他人 pin filter は API 側 own/read_all 境界に従う", async () => {
    // bbox 追加が既存の権限境界を壊していないこと
    (getApiSession as Mock).mockResolvedValue(officeUser);
    (getUserPermissions as Mock).mockResolvedValue(officePerms);
    (prisma.fieldSurveyPin.findMany as Mock).mockResolvedValue([]);
    await LIST(
      makeReq(
        "http://x/api/field-survey/pins?north=35.7&south=35.6&east=139.8&west=139.7&staffUserId=99999999-9999-4999-8999-999999999999",
      ),
    );
    const args = (prisma.fieldSurveyPin.findMany as Mock).mock.calls[0][0];
    expect(args.where.staffUserId).toBe("99999999-9999-4999-8999-999999999999");
    expect(args.where.lat).toEqual({ gte: 35.6, lte: 35.7 });
  });

  // --- Codex Phase 1-E: view=map projection (memo を response に載せない) ---

  it("view=map 指定時、response の各 row に memo key が含まれず hasMemo:boolean を返す", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveyPin.findMany as Mock).mockResolvedValue([
      {
        id: "pin-1",
        sessionId: null,
        staffUserId: fieldUser.id,
        propertyId: null,
        lat: 35.68,
        lng: 139.75,
        accuracy: 5,
        pinType: "candidate",
        status: "open",
        memo: "non-empty memo body",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "pin-2",
        sessionId: null,
        staffUserId: fieldUser.id,
        propertyId: null,
        lat: 35.68,
        lng: 139.75,
        accuracy: 5,
        pinType: "interesting",
        status: "open",
        memo: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "pin-3",
        sessionId: null,
        staffUserId: fieldUser.id,
        propertyId: null,
        lat: 35.68,
        lng: 139.75,
        accuracy: 5,
        pinType: "blocked",
        status: "open",
        memo: "   ", // whitespace のみは false 扱い
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const res = await LIST(
      makeReq(
        "http://x/api/field-survey/pins?view=map&north=35.7&south=35.6&east=139.8&west=139.7",
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const row of body.data) {
      expect(row).not.toHaveProperty("memo");
      expect(typeof row.hasMemo).toBe("boolean");
    }
    expect(body.data[0].hasMemo).toBe(true); // 通常 memo
    expect(body.data[1].hasMemo).toBe(false); // null
    expect(body.data[2].hasMemo).toBe(false); // whitespace only
  });

  it("view=map の response 全体に memo 本文文字列が一切含まれない", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    const secret = "TOP_SECRET_MEMO_BODY_42";
    (prisma.fieldSurveyPin.findMany as Mock).mockResolvedValue([
      {
        id: "pin-x",
        sessionId: null,
        staffUserId: fieldUser.id,
        propertyId: null,
        lat: 35.68,
        lng: 139.75,
        accuracy: null,
        pinType: "candidate",
        status: "open",
        memo: secret,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const res = await LIST(
      makeReq(
        "http://x/api/field-survey/pins?view=map&north=35.7&south=35.6&east=139.8&west=139.7",
      ),
    );
    const text = await res.text();
    expect(text).not.toContain(secret);
    expect(text).not.toMatch(/"memo"/);
  });

  it("view 未指定 (generic) は既存どおり memo を返す (後方互換)", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveyPin.findMany as Mock).mockResolvedValue([
      {
        id: "pin-1",
        sessionId: null,
        staffUserId: fieldUser.id,
        propertyId: null,
        lat: 35.68,
        lng: 139.75,
        accuracy: 5,
        pinType: "candidate",
        status: "open",
        memo: "kept",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const res = await LIST(makeReq("http://x/api/field-survey/pins"));
    const body = await res.json();
    expect(body.data[0]).toHaveProperty("memo", "kept");
    expect(body.data[0]).not.toHaveProperty("hasMemo");
  });

  it("view=map でも bbox / own / read_all / archived 既存ガードが効く", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveyPin.findMany as Mock).mockResolvedValue([]);
    await LIST(
      makeReq(
        "http://x/api/field-survey/pins?view=map&north=35.7&south=35.6&east=139.8&west=139.7",
      ),
    );
    const args = (prisma.fieldSurveyPin.findMany as Mock).mock.calls[0][0];
    // own only 強制
    expect(args.where.staffUserId).toBe(fieldUser.id);
    // bbox
    expect(args.where.lat).toEqual({ gte: 35.6, lte: 35.7 });
    expect(args.where.lng).toEqual({ gte: 139.7, lte: 139.8 });
    // archived default 除外
    expect(args.where.status).toEqual({ not: "archived" });
  });

  it("view=invalid は 422 で reject", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    const res = await LIST(
      makeReq("http://x/api/field-survey/pins?view=detail"),
    );
    expect(res.status).toBe(422);
  });

  // --- Codex P1: Decimal coordinate normalization in view=map ---

  it("view=map で Decimal-like lat/lng/accuracy を number に正規化", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveyPin.findMany as Mock).mockResolvedValue([
      {
        id: "pin-dec",
        sessionId: null,
        staffUserId: fieldUser.id,
        propertyId: null,
        lat: { toString: () => "35.6812000" },
        lng: { toString: () => "139.7671000" },
        accuracy: { toString: () => "8.50" },
        pinType: "candidate",
        status: "open",
        memo: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const res = await LIST(
      makeReq(
        "http://x/api/field-survey/pins?view=map&north=35.7&south=35.6&east=139.8&west=139.7",
      ),
    );
    const body = await res.json();
    const row = body.data[0];
    expect(typeof row.lat).toBe("number");
    expect(typeof row.lng).toBe("number");
    expect(typeof row.accuracy).toBe("number");
    expect(row.lat).toBeCloseTo(35.6812);
    expect(row.lng).toBeCloseTo(139.7671);
    expect(row.accuracy).toBeCloseTo(8.5);
    // memo 本文は依然として含まれない
    expect(row).not.toHaveProperty("memo");
    expect(typeof row.hasMemo).toBe("boolean");
  });

  it("view=map で numeric string lat/lng を number に変換", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveyPin.findMany as Mock).mockResolvedValue([
      {
        id: "pin-str",
        sessionId: null,
        staffUserId: fieldUser.id,
        propertyId: null,
        lat: "35.65",
        lng: "139.75",
        accuracy: null,
        pinType: "candidate",
        status: "open",
        memo: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const res = await LIST(
      makeReq(
        "http://x/api/field-survey/pins?view=map&north=35.7&south=35.6&east=139.8&west=139.7",
      ),
    );
    const body = await res.json();
    expect(typeof body.data[0].lat).toBe("number");
    expect(typeof body.data[0].lng).toBe("number");
    expect(body.data[0].accuracy).toBeNull();
  });

  it("view=map で範囲外 / 非数値 lat/lng は null になる", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveyPin.findMany as Mock).mockResolvedValue([
      {
        id: "pin-bad",
        sessionId: null,
        staffUserId: fieldUser.id,
        propertyId: null,
        lat: "abc",
        lng: 999,
        accuracy: -1,
        pinType: "candidate",
        status: "open",
        memo: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const res = await LIST(
      makeReq(
        "http://x/api/field-survey/pins?view=map&north=35.7&south=35.6&east=139.8&west=139.7",
      ),
    );
    const body = await res.json();
    expect(body.data[0].lat).toBeNull();
    expect(body.data[0].lng).toBeNull();
    expect(body.data[0].accuracy).toBeNull();
  });
});

// ============================================================
// GET /api/field-survey/pins/[id] (detail)
// ============================================================
describe("GET /api/field-survey/pins/[id] (detail)", () => {
  const params = Promise.resolve({ id: PIN_ID });

  it("read 不所持は 403", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue([]);
    const res = await DETAIL(
      makeReq(`http://x/api/field-survey/pins/${PIN_ID}`),
      { params },
    );
    expect(res.status).toBe(403);
  });

  it("未存在は 404", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveyPin.findUnique as Mock).mockResolvedValue(null);
    const res = await DETAIL(
      makeReq(`http://x/api/field-survey/pins/${PIN_ID}`),
      { params },
    );
    expect(res.status).toBe(404);
  });

  it("own pin は read のみで取得可 + AuditLog なし", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveyPin.findUnique as Mock).mockResolvedValue({
      id: PIN_ID,
      sessionId: null,
      staffUserId: fieldUser.id,
      propertyId: null,
      lat: baseLat,
      lng: baseLng,
      accuracy: null,
      pinType: "candidate",
      status: "open",
      memo: "private",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await DETAIL(
      makeReq(`http://x/api/field-survey/pins/${PIN_ID}`),
      { params },
    );
    expect(res.status).toBe(200);
    expect(writeAuditLog).not.toHaveBeenCalled();
    const body = await res.json();
    // business response には lat/lng/memo を含む (UI 表示用)
    expect(body.data.lat).toBe(baseLat);
    expect(body.data.memo).toBe("private");
  });

  it("他人 pin は read のみで 403", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveyPin.findUnique as Mock).mockResolvedValue({
      id: PIN_ID,
      staffUserId: "other-user",
      sessionId: null,
      propertyId: null,
      lat: 0,
      lng: 0,
      accuracy: null,
      pinType: "candidate",
      status: "open",
      memo: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await DETAIL(
      makeReq(`http://x/api/field-survey/pins/${PIN_ID}`),
      { params },
    );
    expect(res.status).toBe(403);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("他人 pin は read_all で取得可 + AuditLog (座標非含有)", async () => {
    (getApiSession as Mock).mockResolvedValue(officeUser);
    (getUserPermissions as Mock).mockResolvedValue(officePerms);
    (prisma.fieldSurveyPin.findUnique as Mock).mockResolvedValue({
      id: PIN_ID,
      staffUserId: "other-user",
      sessionId: null,
      propertyId: PROPERTY_ID,
      lat: baseLat,
      lng: baseLng,
      accuracy: 5,
      pinType: "candidate",
      status: "open",
      memo: "x",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await DETAIL(
      makeReq(`http://x/api/field-survey/pins/${PIN_ID}`),
      { params },
    );
    expect(res.status).toBe(200);
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    const call = writeAuditLog.mock.calls[0][0];
    expect(call.action).toBe("field_survey_pin_view");
    expect(call.detail).toEqual({
      pinId: PIN_ID,
      ownerStaffUserId: "other-user",
      hasProperty: true,
    });
    const s = JSON.stringify(call.detail);
    expect(s).not.toMatch(/lat/i);
    expect(s).not.toMatch(/lng/i);
    expect(s).not.toMatch(/accuracy/i);
    expect(s).not.toMatch(/memo/i);
  });
});

// ============================================================
// PATCH /api/field-survey/pins/[id]
// ============================================================
describe("PATCH /api/field-survey/pins/[id]", () => {
  const params = Promise.resolve({ id: PIN_ID });

  it("write 不所持は 403", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue([
      { resource: "field_survey", action: "read", granted: true },
    ]);
    const res = await PATCH(
      makeReq(`http://x/api/field-survey/pins/${PIN_ID}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "closed" }),
      }),
      { params },
    );
    expect(res.status).toBe(403);
  });

  it("malformed JSON は 400", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    const res = await PATCH(
      makeReq(`http://x/api/field-survey/pins/${PIN_ID}`, {
        method: "PATCH",
        body: "{ broken",
      }),
      { params },
    );
    expect(res.status).toBe(400);
    expect(prisma.fieldSurveyPin.update).not.toHaveBeenCalled();
  });

  it("未存在は 404", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveyPin.findUnique as Mock).mockResolvedValue(null);
    const res = await PATCH(
      makeReq(`http://x/api/field-survey/pins/${PIN_ID}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "closed" }),
      }),
      { params },
    );
    expect(res.status).toBe(404);
  });

  it("lat / lng を送ると strict() で 422", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    const res = await PATCH(
      makeReq(`http://x/api/field-survey/pins/${PIN_ID}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "closed", lat: 0 }),
      }),
      { params },
    );
    expect(res.status).toBe(422);
    expect(prisma.fieldSurveyPin.update).not.toHaveBeenCalled();
  });

  it("空 body は 422", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    const res = await PATCH(
      makeReq(`http://x/api/field-survey/pins/${PIN_ID}`, {
        method: "PATCH",
        body: JSON.stringify({}),
      }),
      { params },
    );
    expect(res.status).toBe(422);
  });

  it("他人 pin 更新は manage なしで 403", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveyPin.findUnique as Mock).mockResolvedValue({
      id: PIN_ID,
      staffUserId: "other-user",
      sessionId: null,
      propertyId: null,
      pinType: "candidate",
      status: "open",
    });
    const res = await PATCH(
      makeReq(`http://x/api/field-survey/pins/${PIN_ID}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "closed" }),
      }),
      { params },
    );
    expect(res.status).toBe(403);
    expect(prisma.fieldSurveyPin.update).not.toHaveBeenCalled();
  });

  it("office_staff (read_all のみ・write なし) は own でも 403", async () => {
    (getApiSession as Mock).mockResolvedValue(officeUser);
    (getUserPermissions as Mock).mockResolvedValue(officePerms);
    const res = await PATCH(
      makeReq(`http://x/api/field-survey/pins/${PIN_ID}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "closed" }),
      }),
      { params },
    );
    expect(res.status).toBe(403);
  });

  it("own pin 更新成功 + AuditLog (座標・memo 本文非含有)", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveyPin.findUnique as Mock).mockResolvedValue({
      id: PIN_ID,
      staffUserId: fieldUser.id,
      sessionId: null,
      propertyId: null,
      pinType: "candidate",
      status: "open",
    });
    (prisma.fieldSurveyPin.update as Mock).mockResolvedValue({
      id: PIN_ID,
      sessionId: null,
      staffUserId: fieldUser.id,
      propertyId: null,
      lat: 0,
      lng: 0,
      accuracy: null,
      pinType: "candidate",
      status: "closed",
      memo: "secret content",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await PATCH(
      makeReq(`http://x/api/field-survey/pins/${PIN_ID}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "closed", memo: "secret content" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    const call = writeAuditLog.mock.calls[0][0];
    expect(call.action).toBe("field_survey_pin_update");
    expect(call.detail.pinId).toBe(PIN_ID);
    expect(call.detail.changedFields).toEqual(["status", "memo"]);
    expect(call.detail.statusBefore).toBe("open");
    expect(call.detail.statusAfter).toBe("closed");
    const s = JSON.stringify(call.detail);
    expect(s).not.toMatch(/lat/i);
    expect(s).not.toMatch(/lng/i);
    expect(s).not.toMatch(/secret content/);
  });

  it("admin (manage) は他人 pin を archive できる", async () => {
    (getApiSession as Mock).mockResolvedValue(adminUser);
    (getUserPermissions as Mock).mockResolvedValue(adminPerms);
    (prisma.fieldSurveyPin.findUnique as Mock).mockResolvedValue({
      id: PIN_ID,
      staffUserId: "other-user",
      sessionId: null,
      propertyId: null,
      pinType: "candidate",
      status: "open",
    });
    (prisma.fieldSurveyPin.update as Mock).mockResolvedValue({
      id: PIN_ID,
      sessionId: null,
      staffUserId: "other-user",
      propertyId: null,
      lat: 0,
      lng: 0,
      accuracy: null,
      pinType: "candidate",
      status: "archived",
      memo: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await PATCH(
      makeReq(`http://x/api/field-survey/pins/${PIN_ID}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "archived" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
  });

  it("propertyId null で解除可", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveyPin.findUnique as Mock).mockResolvedValue({
      id: PIN_ID,
      staffUserId: fieldUser.id,
      sessionId: null,
      propertyId: PROPERTY_ID,
      pinType: "candidate",
      status: "open",
    });
    (prisma.fieldSurveyPin.update as Mock).mockResolvedValue({
      id: PIN_ID,
      sessionId: null,
      staffUserId: fieldUser.id,
      propertyId: null,
      lat: 0,
      lng: 0,
      accuracy: null,
      pinType: "candidate",
      status: "open",
      memo: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await PATCH(
      makeReq(`http://x/api/field-survey/pins/${PIN_ID}`, {
        method: "PATCH",
        body: JSON.stringify({ propertyId: null }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    const updateArgs = (prisma.fieldSurveyPin.update as Mock).mock.calls[0][0];
    expect(updateArgs.data.propertyId).toBeNull();
    const call = writeAuditLog.mock.calls[0][0];
    expect(call.detail.changedFields).toContain("propertyId");
  });

  it("propertyId 紐付け: field_staff が createdBy/assignedTo 非一致は 403", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveyPin.findUnique as Mock).mockResolvedValue({
      id: PIN_ID,
      staffUserId: fieldUser.id,
      sessionId: null,
      propertyId: null,
      pinType: "candidate",
      status: "open",
    });
    (prisma.property.findUnique as Mock).mockResolvedValue({
      id: PROPERTY_ID,
      createdBy: "other-user",
      assignedTo: null,
    });
    const res = await PATCH(
      makeReq(`http://x/api/field-survey/pins/${PIN_ID}`, {
        method: "PATCH",
        body: JSON.stringify({ propertyId: PROPERTY_ID }),
      }),
      { params },
    );
    expect(res.status).toBe(403);
    expect(prisma.fieldSurveyPin.update).not.toHaveBeenCalled();
  });

  it("sessionId 紐付け: manage でも pin 所有者と session 所有者が異なれば 409 SESSION_OWNER_MISMATCH (P1-2)", async () => {
    (getApiSession as Mock).mockResolvedValue(adminUser);
    (getUserPermissions as Mock).mockResolvedValue(adminPerms);
    (prisma.fieldSurveyPin.findUnique as Mock).mockResolvedValue({
      id: PIN_ID,
      staffUserId: "other-user",
      sessionId: null,
      propertyId: null,
      pinType: "candidate",
      status: "open",
      memo: null,
    });
    (prisma.fieldSurveySession.findUnique as Mock).mockResolvedValue({
      staffUserId: "yet-another",
      status: "active",
    });
    const res = await PATCH(
      makeReq(`http://x/api/field-survey/pins/${PIN_ID}`, {
        method: "PATCH",
        body: JSON.stringify({ sessionId: SESSION_ID }),
      }),
      { params },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("SESSION_OWNER_MISMATCH");
    expect(prisma.fieldSurveyPin.update).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("sessionId 紐付け: manage が他人 pin をその所有者の active session へ紐付けは可", async () => {
    (getApiSession as Mock).mockResolvedValue(adminUser);
    (getUserPermissions as Mock).mockResolvedValue(adminPerms);
    (prisma.fieldSurveyPin.findUnique as Mock).mockResolvedValue({
      id: PIN_ID,
      staffUserId: "other-user",
      sessionId: null,
      propertyId: null,
      pinType: "candidate",
      status: "open",
      memo: null,
    });
    (prisma.fieldSurveySession.findUnique as Mock).mockResolvedValue({
      staffUserId: "other-user", // pin 所有者と一致
      status: "active",
    });
    (prisma.fieldSurveyPin.update as Mock).mockResolvedValue({
      id: PIN_ID,
      sessionId: SESSION_ID,
      staffUserId: "other-user",
      propertyId: null,
      lat: 0,
      lng: 0,
      accuracy: null,
      pinType: "candidate",
      status: "open",
      memo: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await PATCH(
      makeReq(`http://x/api/field-survey/pins/${PIN_ID}`, {
        method: "PATCH",
        body: JSON.stringify({ sessionId: SESSION_ID }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    const call = writeAuditLog.mock.calls[0][0];
    expect(call.detail.changedFields).toContain("sessionId");
  });

  it("quick_capture が無いと sessionId=null の解除は 403 (POST ゲートの迂回防止)", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveyPin.findUnique as Mock).mockResolvedValue({
      id: PIN_ID,
      staffUserId: fieldUser.id,
      sessionId: SESSION_ID,
      propertyId: null,
      pinType: "candidate",
      status: "open",
      memo: null,
    });
    const res = await PATCH(
      makeReq(`http://x/api/field-survey/pins/${PIN_ID}`, {
        method: "PATCH",
        body: JSON.stringify({ sessionId: null }),
      }),
      { params: Promise.resolve({ id: PIN_ID }) },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("QUICK_CAPTURE_FORBIDDEN");
    expect(prisma.fieldSurveyPin.update).not.toHaveBeenCalled();
  });

  it("sessionId=null で解除可 / SESSION_OWNER_MISMATCH チェックを経由しない", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    // 巡回紐づけの解除は巡回外ピンを作るのと同じ結果になるため quick_capture が必要。
    (getUserPermissions as Mock).mockResolvedValue(quickCapturePerms);
    (prisma.fieldSurveyPin.findUnique as Mock).mockResolvedValue({
      id: PIN_ID,
      staffUserId: fieldUser.id,
      sessionId: SESSION_ID,
      propertyId: null,
      pinType: "candidate",
      status: "open",
      memo: null,
    });
    (prisma.fieldSurveyPin.update as Mock).mockResolvedValue({
      id: PIN_ID,
      sessionId: null,
      staffUserId: fieldUser.id,
      propertyId: null,
      lat: 0,
      lng: 0,
      accuracy: null,
      pinType: "candidate",
      status: "open",
      memo: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await PATCH(
      makeReq(`http://x/api/field-survey/pins/${PIN_ID}`, {
        method: "PATCH",
        body: JSON.stringify({ sessionId: null }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    // session.findUnique は呼ばれない (null パスは認可スキップ)
    expect(prisma.fieldSurveySession.findUnique).not.toHaveBeenCalled();
    const call = writeAuditLog.mock.calls[0][0];
    expect(call.detail.changedFields).toContain("sessionId");
  });

  it("memo: 既存と同値なら changedFields に入らない / AuditLog なし (P2)", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveyPin.findUnique as Mock).mockResolvedValue({
      id: PIN_ID,
      staffUserId: fieldUser.id,
      sessionId: null,
      propertyId: null,
      pinType: "candidate",
      status: "open",
      memo: "same-value",
    });
    (prisma.fieldSurveyPin.update as Mock).mockResolvedValue({
      id: PIN_ID,
      sessionId: null,
      staffUserId: fieldUser.id,
      propertyId: null,
      lat: 0,
      lng: 0,
      accuracy: null,
      pinType: "candidate",
      status: "open",
      memo: "same-value",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await PATCH(
      makeReq(`http://x/api/field-survey/pins/${PIN_ID}`, {
        method: "PATCH",
        body: JSON.stringify({ memo: "same-value" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("memo: null 既存に対し null 指定も no-op (changedFields 空 / AuditLog なし)", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveyPin.findUnique as Mock).mockResolvedValue({
      id: PIN_ID,
      staffUserId: fieldUser.id,
      sessionId: null,
      propertyId: null,
      pinType: "candidate",
      status: "open",
      memo: null,
    });
    (prisma.fieldSurveyPin.update as Mock).mockResolvedValue({
      id: PIN_ID,
      sessionId: null,
      staffUserId: fieldUser.id,
      propertyId: null,
      lat: 0,
      lng: 0,
      accuracy: null,
      pinType: "candidate",
      status: "open",
      memo: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await PATCH(
      makeReq(`http://x/api/field-survey/pins/${PIN_ID}`, {
        method: "PATCH",
        body: JSON.stringify({ memo: null }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("memo: 実際に変わった場合のみ changedFields に memo が入る", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveyPin.findUnique as Mock).mockResolvedValue({
      id: PIN_ID,
      staffUserId: fieldUser.id,
      sessionId: null,
      propertyId: null,
      pinType: "candidate",
      status: "open",
      memo: "old",
    });
    (prisma.fieldSurveyPin.update as Mock).mockResolvedValue({
      id: PIN_ID,
      sessionId: null,
      staffUserId: fieldUser.id,
      propertyId: null,
      lat: 0,
      lng: 0,
      accuracy: null,
      pinType: "candidate",
      status: "open",
      memo: "new",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await PATCH(
      makeReq(`http://x/api/field-survey/pins/${PIN_ID}`, {
        method: "PATCH",
        body: JSON.stringify({ memo: "new" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    const call = writeAuditLog.mock.calls[0][0];
    expect(call.detail.changedFields).toEqual(["memo"]);
    // memo 本文は AuditLog detail に入らない
    const s = JSON.stringify(call.detail);
    expect(s).not.toMatch(/"new"/);
    expect(s).not.toMatch(/"old"/);
  });

  it("無変更 (changedFields 空) でも 200・AuditLog は書かない", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveyPin.findUnique as Mock).mockResolvedValue({
      id: PIN_ID,
      staffUserId: fieldUser.id,
      sessionId: null,
      propertyId: null,
      pinType: "candidate",
      status: "open",
    });
    (prisma.fieldSurveyPin.update as Mock).mockResolvedValue({
      id: PIN_ID,
      sessionId: null,
      staffUserId: fieldUser.id,
      propertyId: null,
      lat: 0,
      lng: 0,
      accuracy: null,
      pinType: "candidate",
      status: "open",
      memo: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // status を同じ値で更新 → changedFields 空
    const res = await PATCH(
      makeReq(`http://x/api/field-survey/pins/${PIN_ID}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "open" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});

// ============================================================
// DELETE /api/field-survey/pins/[id] (Phase 1-I 論理削除)
// ============================================================
describe("DELETE /api/field-survey/pins/[id]", () => {
  const params = Promise.resolve({ id: PIN_ID });

  function deleteReq() {
    return makeReq(`http://x/api/field-survey/pins/${PIN_ID}`, {
      method: "DELETE",
    });
  }

  it("own pin を archived 化できる (物理削除しない / 写真も消さない)", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveyPin.findUnique as Mock).mockResolvedValue({
      id: PIN_ID,
      staffUserId: fieldUser.id,
      status: "open",
    });
    (prisma.fieldSurveyPin.updateMany as Mock).mockResolvedValue({ count: 1 });

    const res = await DELETE(deleteReq(), { params });
    expect(res.status).toBe(200);
    const updArgs = (prisma.fieldSurveyPin.updateMany as Mock).mock.calls[0][0];
    expect(updArgs.data.status).toBe("archived");
    expect(updArgs.where).toMatchObject({ id: PIN_ID, status: { not: "archived" } });
    // 物理削除されない / 写真は消さない
    expect(prisma.fieldSurveyPin.delete).not.toHaveBeenCalled();
    expect(prisma.fieldSurveyPin.deleteMany).not.toHaveBeenCalled();
    expect(prisma.fieldSurveyPinPhoto.delete).not.toHaveBeenCalled();
    expect(prisma.fieldSurveyPinPhoto.deleteMany).not.toHaveBeenCalled();
  });

  it("成功レスポンスは id / status のみ (座標・memo・写真を含めない)", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveyPin.findUnique as Mock).mockResolvedValue({
      id: PIN_ID,
      staffUserId: fieldUser.id,
      status: "open",
    });
    (prisma.fieldSurveyPin.updateMany as Mock).mockResolvedValue({ count: 1 });
    const res = await DELETE(deleteReq(), { params });
    const body = await res.json();
    expect(body.data).toEqual({ id: PIN_ID, status: "archived" });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/lat|lng|memo|fileUrl|storageKey|fileName/i);
  });

  it("一般スタッフは他人 pin を削除できない (manage なし → 403)", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveyPin.findUnique as Mock).mockResolvedValue({
      id: PIN_ID,
      staffUserId: "other-user",
      status: "open",
    });
    const res = await DELETE(deleteReq(), { params });
    expect(res.status).toBe(403);
    expect(prisma.fieldSurveyPin.updateMany).not.toHaveBeenCalled();
  });

  it("read_all だけでは削除できない (write/manage なし → 403)", async () => {
    (getApiSession as Mock).mockResolvedValue(officeUser);
    (getUserPermissions as Mock).mockResolvedValue(officePerms);
    const res = await DELETE(deleteReq(), { params });
    expect(res.status).toBe(403);
    expect(prisma.fieldSurveyPin.findUnique).not.toHaveBeenCalled();
    expect(prisma.fieldSurveyPin.updateMany).not.toHaveBeenCalled();
  });

  it("manage なら他人 pin を削除できる", async () => {
    (getApiSession as Mock).mockResolvedValue(adminUser);
    (getUserPermissions as Mock).mockResolvedValue(adminPerms);
    (prisma.fieldSurveyPin.findUnique as Mock).mockResolvedValue({
      id: PIN_ID,
      staffUserId: "other-user",
      status: "open",
    });
    (prisma.fieldSurveyPin.updateMany as Mock).mockResolvedValue({ count: 1 });
    const res = await DELETE(deleteReq(), { params });
    expect(res.status).toBe(200);
    expect(prisma.fieldSurveyPin.updateMany).toHaveBeenCalledTimes(1);
    const call = writeAuditLog.mock.calls[0][0];
    expect(call.detail).toEqual({
      pinId: PIN_ID,
      targetOwner: "other",
      viaManage: true,
    });
  });

  it("存在しない pin は 404", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveyPin.findUnique as Mock).mockResolvedValue(null);
    const res = await DELETE(deleteReq(), { params });
    expect(res.status).toBe(404);
  });

  it("archived 済の再削除は安全 (200 / 0 行更新 / AuditLog なし)", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveyPin.findUnique as Mock).mockResolvedValue({
      id: PIN_ID,
      staffUserId: fieldUser.id,
      status: "archived",
    });
    (prisma.fieldSurveyPin.updateMany as Mock).mockResolvedValue({ count: 0 });
    const res = await DELETE(deleteReq(), { params });
    expect(res.status).toBe(200);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("AuditLog detail に lat/lng/memo/photoUrl/storageKey/fileName/PII が入らない", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveyPin.findUnique as Mock).mockResolvedValue({
      id: PIN_ID,
      staffUserId: fieldUser.id,
      status: "open",
    });
    (prisma.fieldSurveyPin.updateMany as Mock).mockResolvedValue({ count: 1 });
    await DELETE(deleteReq(), { params });
    const call = writeAuditLog.mock.calls[0][0];
    expect(call.detail).toEqual({
      pinId: PIN_ID,
      targetOwner: "own",
      viaManage: false,
    });
    const serialized = JSON.stringify(call);
    expect(serialized).not.toMatch(/lat|lng|memo|fileUrl|storageKey|fileName/i);
  });
});
