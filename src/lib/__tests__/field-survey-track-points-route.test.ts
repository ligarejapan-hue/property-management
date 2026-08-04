/**
 * /api/field-survey/sessions/[id]/track-points route tests (Phase 1-B).
 *
 * 検証ポイント:
 *  - POST: 権限境界 / active session ガード / clock-skew validation /
 *    skipDuplicates + pointCount increment / transaction rollback
 *  - GET:  own / read_all / manage 境界 / cursor pagination /
 *    他スタッフ閲覧時のみ AuditLog (座標非含有)
 *  - 共通: AuditLog detail / response body に lat/lng/accuracy/points 配列を
 *    含めない
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

// Prisma stub。$transaction は引数の callback に tx (=同じ shape の prisma stub)
// を渡して呼ぶ単純な実装。実 DB ACID は別途 integration test で担保する想定。
vi.mock("@/lib/prisma", () => {
  const sessionTx = {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  };
  const pointTx = {
    createMany: vi.fn(),
  };
  const root = {
    fieldSurveySession: {
      findUnique: vi.fn(),
    },
    fieldSurveyTrackPoint: {
      findMany: vi.fn(),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
      fn({
        fieldSurveySession: sessionTx,
        fieldSurveyTrackPoint: pointTx,
      }),
    ),
    _tx: { sessionTx, pointTx },
  };
  return { default: root };
});

import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
} from "@/lib/api-helpers";
import {
  POST,
  GET,
} from "@/app/api/field-survey/sessions/[id]/track-points/route";

type PrismaMock = typeof prisma & {
  _tx: {
    sessionTx: {
      findUnique: Mock;
      updateMany: Mock;
    };
    pointTx: {
      createMany: Mock;
    };
  };
};
const pm = prisma as unknown as PrismaMock;

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

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const params = Promise.resolve({ id: SESSION_ID });

function makeReq(url: string, init?: RequestInit) {
  return new Request(url, init) as unknown as import("next/server").NextRequest;
}

function buildActiveSession(overrides: Partial<{
  staffUserId: string;
  startedAt: Date;
}> = {}) {
  return {
    id: SESSION_ID,
    staffUserId: overrides.staffUserId ?? fieldUser.id,
    status: "active" as const,
    startedAt: overrides.startedAt ?? new Date(Date.now() - 60_000),
  };
}

function makePoint(overrides: Partial<{
  sequence: number;
  lat: number;
  lng: number;
  accuracy: number | null;
  recordedAt: string;
}> = {}) {
  return {
    sequence: overrides.sequence ?? 0,
    lat: overrides.lat ?? 35.6812,
    lng: overrides.lng ?? 139.7671,
    accuracy: overrides.accuracy ?? 10,
    recordedAt:
      overrides.recordedAt ?? new Date(Date.now() - 30_000).toISOString(),
  };
}

// ============================================================
// POST /api/field-survey/sessions/[id]/track-points
// ============================================================
describe("POST track-points", () => {
  it("未ログインは 401", async () => {
    (getApiSession as Mock).mockRejectedValueOnce(
      new ApiError(401, "認証が必要です", "UNAUTHORIZED"),
    );
    const res = await POST(
      makeReq(`http://x/api/field-survey/sessions/${SESSION_ID}/track-points`, {
        method: "POST",
        body: JSON.stringify({ points: [makePoint()] }),
      }),
      { params },
    );
    expect(res.status).toBe(401);
  });

  it("field_survey:write 不所持は 403 / DB に到達しない", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue([
      { resource: "field_survey", action: "read", granted: true },
    ]);
    const res = await POST(
      makeReq(`http://x/api/field-survey/sessions/${SESSION_ID}/track-points`, {
        method: "POST",
        body: JSON.stringify({ points: [makePoint()] }),
      }),
      { params },
    );
    expect(res.status).toBe(403);
    expect(pm.$transaction).not.toHaveBeenCalled();
  });

  it("malformed JSON は 400 INVALID_JSON / DB と AuditLog に到達しない", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    const res = await POST(
      makeReq(`http://x/api/field-survey/sessions/${SESSION_ID}/track-points`, {
        method: "POST",
        body: "{ broken",
      }),
      { params },
    );
    expect(res.status).toBe(400);
    expect(pm.$transaction).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("batch 200 件超は 422", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    const points = Array.from({ length: 201 }, (_, i) =>
      makePoint({ sequence: i }),
    );
    const res = await POST(
      makeReq(`http://x/api/field-survey/sessions/${SESSION_ID}/track-points`, {
        method: "POST",
        body: JSON.stringify({ points }),
      }),
      { params },
    );
    expect(res.status).toBe(422);
    expect(pm.$transaction).not.toHaveBeenCalled();
  });

  it("同一 payload 内の duplicate sequence は 422", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    const res = await POST(
      makeReq(`http://x/api/field-survey/sessions/${SESSION_ID}/track-points`, {
        method: "POST",
        body: JSON.stringify({
          points: [
            makePoint({ sequence: 5 }),
            makePoint({ sequence: 5 }),
          ],
        }),
      }),
      { params },
    );
    expect(res.status).toBe(422);
  });

  it("session が無いと 404", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    pm._tx.sessionTx.findUnique.mockResolvedValue(null);
    const res = await POST(
      makeReq(`http://x/api/field-survey/sessions/${SESSION_ID}/track-points`, {
        method: "POST",
        body: JSON.stringify({ points: [makePoint()] }),
      }),
      { params },
    );
    expect(res.status).toBe(404);
    expect(pm._tx.pointTx.createMany).not.toHaveBeenCalled();
  });

  it("manage なし + 他人 session は 403", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    pm._tx.sessionTx.findUnique.mockResolvedValue(
      buildActiveSession({ staffUserId: "other-user" }),
    );
    const res = await POST(
      makeReq(`http://x/api/field-survey/sessions/${SESSION_ID}/track-points`, {
        method: "POST",
        body: JSON.stringify({ points: [makePoint()] }),
      }),
      { params },
    );
    expect(res.status).toBe(403);
    expect(pm._tx.pointTx.createMany).not.toHaveBeenCalled();
  });

  it("⚠自動終了した session は受け取る (@codex #356 P1)", async () => {
    // 圏外で貯めた位置記録は、電波が戻ったときに送られる。その間に無操作
    // 1時間で自動終了していると、ここで弾いた瞬間に**歩いた記録がまるごと
    // 失われる**（利用者は送信済みのつもりでいる）。
    // ⚠この手前の関門で弾くと、後段に用意した受け入れ条件に**到達しない**。
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    pm._tx.sessionTx.findUnique.mockResolvedValue({
      id: SESSION_ID,
      staffUserId: fieldUser.id,
      status: "ended",
      endReason: "idle_timeout",
      startedAt: new Date(),
    });
    pm._tx.pointTx.createMany.mockResolvedValue({ count: 1 });
    pm._tx.sessionTx.updateMany.mockResolvedValue({ count: 1 });
    const res = await POST(
      makeReq(`http://x/api/field-survey/sessions/${SESSION_ID}/track-points`, {
        method: "POST",
        body: JSON.stringify({ points: [makePoint()] }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(pm._tx.pointTx.createMany).toHaveBeenCalled();
  });

  it("人が終了した session は 409 INVALID_STATE", async () => {
    // 意図して終えた巡回に後から足すのは誤り（自動終了とは区別する）。
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    pm._tx.sessionTx.findUnique.mockResolvedValue({
      id: SESSION_ID,
      staffUserId: fieldUser.id,
      status: "ended",
      endReason: null,
      startedAt: new Date(),
    });
    const res = await POST(
      makeReq(`http://x/api/field-survey/sessions/${SESSION_ID}/track-points`, {
        method: "POST",
        body: JSON.stringify({ points: [makePoint()] }),
      }),
      { params },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_STATE");
    expect(pm._tx.pointTx.createMany).not.toHaveBeenCalled();
  });

  it("recordedAt 過去すぎは 422 (clock-skew)", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    pm._tx.sessionTx.findUnique.mockResolvedValue(buildActiveSession());
    const tooOld = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const res = await POST(
      makeReq(`http://x/api/field-survey/sessions/${SESSION_ID}/track-points`, {
        method: "POST",
        body: JSON.stringify({
          points: [makePoint({ recordedAt: tooOld })],
        }),
      }),
      { params },
    );
    expect(res.status).toBe(422);
    expect(pm._tx.pointTx.createMany).not.toHaveBeenCalled();
  });

  it("recordedAt 未来すぎは 422 (clock-skew)", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    pm._tx.sessionTx.findUnique.mockResolvedValue(buildActiveSession());
    const tooFuture = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const res = await POST(
      makeReq(`http://x/api/field-survey/sessions/${SESSION_ID}/track-points`, {
        method: "POST",
        body: JSON.stringify({
          points: [makePoint({ recordedAt: tooFuture })],
        }),
      }),
      { params },
    );
    expect(res.status).toBe(422);
    expect(pm._tx.pointTx.createMany).not.toHaveBeenCalled();
  });

  it("正常時: acceptedCount / skippedCount を返し pointCount は実 insert 分のみ increment", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    pm._tx.sessionTx.findUnique.mockResolvedValue(buildActiveSession());
    pm._tx.pointTx.createMany.mockResolvedValue({ count: 2 }); // 3 件中 2 件
    pm._tx.sessionTx.updateMany.mockResolvedValue({ count: 1 });
    const res = await POST(
      makeReq(`http://x/api/field-survey/sessions/${SESSION_ID}/track-points`, {
        method: "POST",
        body: JSON.stringify({
          points: [
            makePoint({ sequence: 0 }),
            makePoint({ sequence: 1 }),
            makePoint({ sequence: 2 }),
          ],
        }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.acceptedCount).toBe(2);
    expect(body.data.skippedCount).toBe(1);
    const updArgs = pm._tx.sessionTx.updateMany.mock.calls[0][0];
    // ⚠**自動終了した巡回も受け取る** (@codex #356 P1)。圏外で貯めた位置記録が
    // 復帰後に 409 で捨てられると、歩いた記録がまるごと失われる。
    // 人が押して終えた巡回 (endReason=null) は従来どおり弾く。
    expect(updArgs.where).toEqual({
      id: SESSION_ID,
      OR: [
        { status: "active" },
        { status: "ended", endReason: "idle_timeout" },
      ],
    });
    expect(updArgs.data.pointCount).toEqual({ increment: 2 });
    // AuditLog は POST では書かない
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("全件 skip (count=0) なら updateMany は呼ばない", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    pm._tx.sessionTx.findUnique.mockResolvedValue(buildActiveSession());
    pm._tx.pointTx.createMany.mockResolvedValue({ count: 0 });
    const res = await POST(
      makeReq(`http://x/api/field-survey/sessions/${SESSION_ID}/track-points`, {
        method: "POST",
        body: JSON.stringify({
          points: [makePoint({ sequence: 0 })],
        }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.acceptedCount).toBe(0);
    expect(body.data.skippedCount).toBe(1);
    expect(pm._tx.sessionTx.updateMany).not.toHaveBeenCalled();
  });

  it("race: increment 直前に session が終了済なら 409 で rollback", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    pm._tx.sessionTx.findUnique.mockResolvedValue(buildActiveSession());
    pm._tx.pointTx.createMany.mockResolvedValue({ count: 1 });
    pm._tx.sessionTx.updateMany.mockResolvedValue({ count: 0 }); // race
    const res = await POST(
      makeReq(`http://x/api/field-survey/sessions/${SESSION_ID}/track-points`, {
        method: "POST",
        body: JSON.stringify({
          points: [makePoint({ sequence: 0 })],
        }),
      }),
      { params },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_STATE");
  });

  it("admin (manage) は他人 session に POST 可", async () => {
    (getApiSession as Mock).mockResolvedValue(adminUser);
    (getUserPermissions as Mock).mockResolvedValue(adminPerms);
    pm._tx.sessionTx.findUnique.mockResolvedValue(
      buildActiveSession({ staffUserId: "other-user" }),
    );
    pm._tx.pointTx.createMany.mockResolvedValue({ count: 1 });
    pm._tx.sessionTx.updateMany.mockResolvedValue({ count: 1 });
    const res = await POST(
      makeReq(`http://x/api/field-survey/sessions/${SESSION_ID}/track-points`, {
        method: "POST",
        body: JSON.stringify({ points: [makePoint()] }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
  });

  it("error response に lat / lng / accuracy / points 配列を含めない", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    pm._tx.sessionTx.findUnique.mockResolvedValue(buildActiveSession());
    const tooOld = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const res = await POST(
      makeReq(`http://x/api/field-survey/sessions/${SESSION_ID}/track-points`, {
        method: "POST",
        body: JSON.stringify({
          points: [makePoint({ recordedAt: tooOld, lat: 35.99, lng: 139.99 })],
        }),
      }),
      { params },
    );
    const text = await res.text();
    expect(text).not.toMatch(/35\.99/);
    expect(text).not.toMatch(/139\.99/);
    expect(text.toLowerCase()).not.toMatch(/"lat"|"lng"|"accuracy"/);
  });
});

// ============================================================
// GET /api/field-survey/sessions/[id]/track-points
// ============================================================
describe("GET track-points", () => {
  it("field_survey:read 不所持は 403", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue([]);
    const res = await GET(
      makeReq(`http://x/api/field-survey/sessions/${SESSION_ID}/track-points`),
      { params },
    );
    expect(res.status).toBe(403);
  });

  it("session 未存在は 404", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (pm.fieldSurveySession.findUnique as Mock).mockResolvedValue(null);
    const res = await GET(
      makeReq(`http://x/api/field-survey/sessions/${SESSION_ID}/track-points`),
      { params },
    );
    expect(res.status).toBe(404);
  });

  it("own session は read のみで取得可 + AuditLog を書かない", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (pm.fieldSurveySession.findUnique as Mock).mockResolvedValue({
      id: SESSION_ID,
      staffUserId: fieldUser.id,
    });
    (pm.fieldSurveyTrackPoint.findMany as Mock).mockResolvedValue([
      {
        sequence: 0,
        lat: 35.0,
        lng: 139.0,
        accuracy: 5,
        recordedAt: new Date(),
      },
    ]);
    const res = await GET(
      makeReq(`http://x/api/field-survey/sessions/${SESSION_ID}/track-points`),
      { params },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBe(1);
    expect(body.nextCursor).toBeNull();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("他人 session は read のみだと 403", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (pm.fieldSurveySession.findUnique as Mock).mockResolvedValue({
      id: SESSION_ID,
      staffUserId: "other-user",
    });
    const res = await GET(
      makeReq(`http://x/api/field-survey/sessions/${SESSION_ID}/track-points`),
      { params },
    );
    expect(res.status).toBe(403);
    expect(pm.fieldSurveyTrackPoint.findMany).not.toHaveBeenCalled();
  });

  it("read_all あれば他人 session を取得可 + AuditLog (座標非含有) を書く", async () => {
    (getApiSession as Mock).mockResolvedValue(officeUser);
    (getUserPermissions as Mock).mockResolvedValue(officePerms);
    (pm.fieldSurveySession.findUnique as Mock).mockResolvedValue({
      id: SESSION_ID,
      staffUserId: "other-user",
    });
    (pm.fieldSurveyTrackPoint.findMany as Mock).mockResolvedValue([
      {
        sequence: 0,
        lat: 35.99,
        lng: 139.99,
        accuracy: 5,
        recordedAt: new Date(),
      },
    ]);
    const res = await GET(
      makeReq(
        `http://x/api/field-survey/sessions/${SESSION_ID}/track-points?from=${new Date().toISOString()}`,
      ),
      { params },
    );
    expect(res.status).toBe(200);
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    const call = writeAuditLog.mock.calls[0][0];
    expect(call.action).toBe("field_survey_track_view");
    expect(call.targetTable).toBe("field_survey_track_points");
    expect(call.targetId).toBe(SESSION_ID);
    expect(call.detail).toEqual({
      sessionId: SESSION_ID,
      viewedStaffUserId: "other-user",
      pointsReturned: 1,
      hasFrom: true,
      hasTo: false,
    });
    const s = JSON.stringify(call.detail);
    expect(s).not.toMatch(/lat/i);
    expect(s).not.toMatch(/lng/i);
    expect(s).not.toMatch(/accuracy/i);
    expect(s).not.toMatch(/bbox/i);
    expect(s).not.toMatch(/\bpoints\b/i);
  });

  it("cursorSequence / limit が反映される (limit+1 take)", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (pm.fieldSurveySession.findUnique as Mock).mockResolvedValue({
      id: SESSION_ID,
      staffUserId: fieldUser.id,
    });
    // limit=2 で 3 件返る場合 → hasNext, data=2件, nextCursor= 2件目の sequence
    (pm.fieldSurveyTrackPoint.findMany as Mock).mockResolvedValue([
      { sequence: 11, lat: 0, lng: 0, accuracy: null, recordedAt: new Date() },
      { sequence: 12, lat: 0, lng: 0, accuracy: null, recordedAt: new Date() },
      { sequence: 13, lat: 0, lng: 0, accuracy: null, recordedAt: new Date() },
    ]);
    const res = await GET(
      makeReq(
        `http://x/api/field-survey/sessions/${SESSION_ID}/track-points?cursorSequence=10&limit=2`,
      ),
      { params },
    );
    const body = await res.json();
    const fmArgs = (pm.fieldSurveyTrackPoint.findMany as Mock).mock.calls[0][0];
    expect(fmArgs.where.sessionId).toBe(SESSION_ID);
    expect(fmArgs.where.sequence).toEqual({ gt: 10 });
    expect(fmArgs.take).toBe(3); // limit + 1
    expect(fmArgs.orderBy).toEqual({ sequence: "asc" });
    expect(body.data.length).toBe(2);
    expect(body.nextCursor).toBe(12);
  });

  it("結果が limit 以下なら nextCursor は null", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (pm.fieldSurveySession.findUnique as Mock).mockResolvedValue({
      id: SESSION_ID,
      staffUserId: fieldUser.id,
    });
    (pm.fieldSurveyTrackPoint.findMany as Mock).mockResolvedValue([
      { sequence: 0, lat: 0, lng: 0, accuracy: null, recordedAt: new Date() },
    ]);
    const res = await GET(
      makeReq(
        `http://x/api/field-survey/sessions/${SESSION_ID}/track-points?limit=10`,
      ),
      { params },
    );
    const body = await res.json();
    expect(body.nextCursor).toBeNull();
  });

  it("admin (manage) は他人 session を取得可 + AuditLog を書く", async () => {
    (getApiSession as Mock).mockResolvedValue(adminUser);
    (getUserPermissions as Mock).mockResolvedValue(adminPerms);
    (pm.fieldSurveySession.findUnique as Mock).mockResolvedValue({
      id: SESSION_ID,
      staffUserId: "other-user",
    });
    (pm.fieldSurveyTrackPoint.findMany as Mock).mockResolvedValue([]);
    const res = await GET(
      makeReq(`http://x/api/field-survey/sessions/${SESSION_ID}/track-points`),
      { params },
    );
    expect(res.status).toBe(200);
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
  });
});
