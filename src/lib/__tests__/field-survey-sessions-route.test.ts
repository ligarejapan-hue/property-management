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
    // 実装と同じ挙動: 空ボディは `{}`、malformed JSON は ApiError(400, INVALID_JSON)
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
  const client = {
    fieldSurveySession: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    fieldSurveyPin: {
      groupBy: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    // interactive transaction: callback へ同一 client を渡す (rollback 自体は
    // DB の責務なのでモックでは検証せず、監査ログ等の観測点で検証する)
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(client),
    ),
  };
  return { default: client };
});

import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
} from "@/lib/api-helpers";
import { POST, GET } from "@/app/api/field-survey/sessions/route";
import {
  PATCH,
  GET as GET_DETAIL,
} from "@/app/api/field-survey/sessions/[id]/route";

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

  it("active session 重複 (事前チェックでヒット・24h 未満) は 409", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveySession.findFirst as Mock).mockResolvedValue({
      id: "s-active",
      startedAt: new Date(Date.now() - 60 * 60 * 1000), // 1h 前 = 放置ではない
      updatedAt: new Date(),
      pointCount: 5,
    });
    const res = await POST(
      makeReq("http://x/api/field-survey/sessions", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(res.status).toBe(409);
    expect(prisma.fieldSurveySession.create).not.toHaveBeenCalled();
    // 放置ではない active を勝手に終了しない
    expect(prisma.fieldSurveySession.updateMany).not.toHaveBeenCalled();
  });

  // ---------- B-7 (UI総点検): 放置 active session の lazy 自動終了 ----------

  it("B-7: 放置 active (24h 超) は自動終了してから新規作成 201 (endedAt=最終活動時刻)", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    const staleStartedAt = new Date(Date.now() - 30 * 60 * 60 * 1000); // 30h 前
    const lastActivityAt = new Date(Date.now() - 29 * 60 * 60 * 1000); // 29h 前
    (prisma.fieldSurveySession.findFirst as Mock).mockResolvedValue({
      id: "s-stale",
      startedAt: staleStartedAt,
      updatedAt: lastActivityAt,
      pointCount: 7,
    });
    (prisma.fieldSurveySession.updateMany as Mock).mockResolvedValue({
      count: 1,
    });
    (prisma.fieldSurveySession.create as Mock).mockResolvedValue({
      id: "s-new",
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
    // 自動終了は atomic conditional update (status=active + updatedAt 一致条件。
    // @codex R1: 読取後の track point flush と競合したら書かない)
    const umArgs = (prisma.fieldSurveySession.updateMany as Mock).mock
      .calls[0][0];
    expect(umArgs.where).toEqual({
      id: "s-stale",
      status: "active",
      updatedAt: lastActivityAt,
    });
    expect(umArgs.data.status).toBe("ended");
    // endedAt は now でなく最終活動時刻 (updatedAt) = 巡回時間の過大記録を避ける
    expect(umArgs.data.endedAt).toEqual(lastActivityAt);
    // 監査ログ: 自動終了 + 通常の開始 の 2 件 (PII / 座標なし)
    expect(writeAuditLog).toHaveBeenCalledTimes(2);
    const autoEndCall = writeAuditLog.mock.calls[0][0];
    expect(autoEndCall.action).toBe("field_survey_session_auto_end");
    expect(autoEndCall.targetId).toBe("s-stale");
    expect(autoEndCall.detail).toEqual({
      sessionId: "s-stale",
      reason: "stale_on_new_start",
      pointCount: 7,
    });
    const serialized = JSON.stringify(autoEndCall.detail);
    expect(serialized).not.toMatch(/lat/i);
    expect(serialized).not.toMatch(/lng/i);
    const startCall = writeAuditLog.mock.calls[1][0];
    expect(startCall.action).toBe("field_survey_session_start");
  });

  it("B-7: 自動終了が 0 行 (並行で終了済み) でも新規作成に進み、自動終了の監査ログは書かない", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveySession.findFirst as Mock)
      .mockResolvedValueOnce({
        id: "s-stale",
        startedAt: new Date(Date.now() - 30 * 60 * 60 * 1000),
        updatedAt: new Date(Date.now() - 29 * 60 * 60 * 1000),
        pointCount: 0,
      })
      // 再読取: 並行で終了済み (active では見つからない)
      .mockResolvedValueOnce(null);
    (prisma.fieldSurveySession.updateMany as Mock).mockResolvedValue({
      count: 0,
    });
    (prisma.fieldSurveySession.create as Mock).mockResolvedValue({
      id: "s-new",
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
    // 自動終了の監査ログは書かず、session_start の 1 件のみ
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    expect(writeAuditLog.mock.calls[0][0].action).toBe(
      "field_survey_session_start",
    );
  });

  it("B-7(@codex R2): 自動終了後の create 失敗 (非P2002) は 500 で、監査ログを一切書かない (rollback 前提)", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveySession.findFirst as Mock).mockResolvedValue({
      id: "s-stale",
      startedAt: new Date(Date.now() - 30 * 60 * 60 * 1000),
      updatedAt: new Date(Date.now() - 29 * 60 * 60 * 1000),
      pointCount: 3,
    });
    (prisma.fieldSurveySession.updateMany as Mock).mockResolvedValue({
      count: 1,
    });
    const dbDown = Object.assign(new Error("connection lost"), {
      code: "P1001",
    });
    (prisma.fieldSurveySession.create as Mock).mockRejectedValueOnce(dbDown);
    const res = await POST(
      makeReq("http://x/api/field-survey/sessions", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(res.status).toBe(500);
    // 自動終了はトランザクション rollback で取り消される前提のため、
    // auto_end / session_start いずれの監査ログも書かない
    expect(writeAuditLog).not.toHaveBeenCalled();
    // 自動終了と create は同一トランザクション内で実行される
    expect(prisma.$transaction as Mock).toHaveBeenCalledTimes(1);
  });

  it("B-7(@codex R3): 開始24h超でも最終活動が新しければ放置扱いせず 409 (自動終了しない)", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveySession.findFirst as Mock).mockResolvedValue({
      id: "s-long",
      startedAt: new Date(Date.now() - 30 * 60 * 60 * 1000), // 30h 前開始
      updatedAt: new Date(Date.now() - 60 * 60 * 1000), // 1h 前まで活動
      pointCount: 100,
    });
    const res = await POST(
      makeReq("http://x/api/field-survey/sessions", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(res.status).toBe(409);
    expect(prisma.fieldSurveySession.updateMany).not.toHaveBeenCalled();
    expect(prisma.fieldSurveySession.create).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("B-7(@codex R1/R3): 読取後に track point flush が入って条件が外れたら、活動中とみなし 409 (再終了しない)", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveySession.findFirst as Mock)
      .mockResolvedValueOnce({
        id: "s-stale",
        startedAt: new Date(Date.now() - 30 * 60 * 60 * 1000),
        updatedAt: new Date(Date.now() - 29 * 60 * 60 * 1000),
        pointCount: 7,
      })
      // 再読取: まだ active (= flush 直後で updatedAt が進んだ)
      .mockResolvedValueOnce({ id: "s-stale" });
    (prisma.fieldSurveySession.updateMany as Mock).mockResolvedValue({
      count: 0, // 古い updatedAt 条件が外れた
    });
    const res = await POST(
      makeReq("http://x/api/field-survey/sessions", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("ACTIVE_SESSION_EXISTS");
    // updateMany は 1 回だけ (最新スナップショットへの再終了はしない)
    expect(prisma.fieldSurveySession.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.fieldSurveySession.create).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("race: 事前チェック通過後 create で P2002 が出ても 409 ACTIVE_SESSION_EXISTS", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveySession.findFirst as Mock).mockResolvedValue(null);
    const p2002 = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
    });
    (prisma.fieldSurveySession.create as Mock).mockRejectedValueOnce(p2002);
    const res = await POST(
      makeReq("http://x/api/field-survey/sessions", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("ACTIVE_SESSION_EXISTS");
  });

  it("create が P2002 以外の Prisma error を投げたら 500", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveySession.findFirst as Mock).mockResolvedValue(null);
    const other = Object.assign(new Error("connection lost"), {
      code: "P1001",
    });
    (prisma.fieldSurveySession.create as Mock).mockRejectedValueOnce(other);
    const res = await POST(
      makeReq("http://x/api/field-survey/sessions", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(res.status).toBe(500);
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

  it("malformed JSON は 400 INVALID_JSON / DB と AuditLog に到達しない", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    const res = await POST(
      makeReq("http://x/api/field-survey/sessions", {
        method: "POST",
        body: "{ broken json",
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_JSON");
    expect(prisma.fieldSurveySession.findFirst).not.toHaveBeenCalled();
    expect(prisma.fieldSurveySession.create).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("空ボディ (memo なし) は通常通り 201", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveySession.findFirst as Mock).mockResolvedValue(null);
    (prisma.fieldSurveySession.create as Mock).mockResolvedValue({
      id: "s-empty",
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
        body: "",
      }),
    );
    expect(res.status).toBe(201);
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

  it("read_all 所持は scope=all + staffUserId 指定を採用", async () => {
    (getApiSession as Mock).mockResolvedValue(officeUser);
    (getUserPermissions as Mock).mockResolvedValue(officePerms);
    (prisma.fieldSurveySession.count as Mock).mockResolvedValue(0);
    (prisma.fieldSurveySession.findMany as Mock).mockResolvedValue([]);
    const target = "22222222-2222-4222-8222-222222222222";
    await GET(
      makeReq(
        `http://x/api/field-survey/sessions?scope=all&staffUserId=${target}`,
      ),
    );
    const where = (prisma.fieldSurveySession.findMany as Mock).mock.calls[0][0]
      .where;
    expect(where.staffUserId).toBe(target);
  });

  it("Codex P2: read_all 所持は scope 未指定でも staffUserId を尊重する", async () => {
    (getApiSession as Mock).mockResolvedValue(officeUser);
    (getUserPermissions as Mock).mockResolvedValue(officePerms);
    (prisma.fieldSurveySession.count as Mock).mockResolvedValue(0);
    (prisma.fieldSurveySession.findMany as Mock).mockResolvedValue([]);
    const target = "22222222-2222-4222-8222-222222222222";
    // scope=all を付けなくても、認可済み caller の staffUserId は own に倒さない。
    await GET(
      makeReq(`http://x/api/field-survey/sessions?staffUserId=${target}`),
    );
    const where = (prisma.fieldSurveySession.findMany as Mock).mock.calls[0][0]
      .where;
    expect(where.staffUserId).toBe(target);
    expect(where.staffUserId).not.toBe(officeUser.id);
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

  // ---------- Phase 1-J: scope / staffName / pinCount ----------

  it("scope=all は一般スタッフ (read_all/manage なし) では 403", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    const res = await GET(
      makeReq("http://x/api/field-survey/sessions?scope=all"),
    );
    expect(res.status).toBe(403);
    expect(prisma.fieldSurveySession.findMany).not.toHaveBeenCalled();
  });

  it("scope=all は read_all で全スタッフ分 (staffUserId 強制しない)", async () => {
    (getApiSession as Mock).mockResolvedValue(officeUser);
    (getUserPermissions as Mock).mockResolvedValue(officePerms);
    (prisma.fieldSurveySession.count as Mock).mockResolvedValue(0);
    (prisma.fieldSurveySession.findMany as Mock).mockResolvedValue([]);
    await GET(makeReq("http://x/api/field-survey/sessions?scope=all"));
    const where = (prisma.fieldSurveySession.findMany as Mock).mock.calls[0][0]
      .where;
    expect(where.staffUserId).toBeUndefined();
  });

  it("scope 未指定 (mine) は read_all 所持でも own 強制", async () => {
    (getApiSession as Mock).mockResolvedValue(officeUser);
    (getUserPermissions as Mock).mockResolvedValue(officePerms);
    (prisma.fieldSurveySession.count as Mock).mockResolvedValue(0);
    (prisma.fieldSurveySession.findMany as Mock).mockResolvedValue([]);
    await GET(makeReq("http://x/api/field-survey/sessions"));
    const where = (prisma.fieldSurveySession.findMany as Mock).mock.calls[0][0]
      .where;
    expect(where.staffUserId).toBe(officeUser.id);
  });

  it("レスポンスに staffName / pinCount を含み、座標/memo/写真/PII を含まない", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveySession.count as Mock).mockResolvedValue(1);
    (prisma.fieldSurveySession.findMany as Mock).mockResolvedValue([
      {
        id: "s-1",
        staffUserId: fieldUser.id,
        startedAt: new Date("2026-05-01T00:00:00Z"),
        endedAt: new Date("2026-05-01T01:00:00Z"),
        status: "ended",
        pointCount: 12,
        createdAt: new Date(),
        updatedAt: new Date(),
        staff: { name: "巡回太郎" },
      },
    ]);
    (prisma.fieldSurveyPin.groupBy as Mock).mockResolvedValue([
      { sessionId: "s-1", _count: { _all: 3 } },
    ]);
    const res = await GET(makeReq("http://x/api/field-survey/sessions"));
    const body = await res.json();
    expect(body.data[0].staffName).toBe("巡回太郎");
    expect(body.data[0].pinCount).toBe(3);
    expect(body.data[0].pointCount).toBe(12);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/memo|fileUrl|storageKey|fileName|"lat"|"lng"/i);
    // pinCount 集計は archived を除外
    const gbWhere = (prisma.fieldSurveyPin.groupBy as Mock).mock.calls[0][0].where;
    expect(gbWhere.status).toEqual({ not: "archived" });
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

  it("admin (manage) は他人 session を終了できる (atomic updateMany)", async () => {
    (getApiSession as Mock).mockResolvedValue(adminUser);
    (getUserPermissions as Mock).mockResolvedValue(adminPerms);
    const startedAt = new Date(Date.now() - 60_000);
    const endedAt = new Date();
    (prisma.fieldSurveySession.findUnique as Mock)
      .mockResolvedValueOnce({
        id: "s-1",
        staffUserId: "other-user",
        startedAt,
        status: "active",
        pointCount: 42,
      })
      .mockResolvedValueOnce({
        id: "s-1",
        staffUserId: "other-user",
        startedAt,
        endedAt,
        status: "ended",
        memo: null,
        pointCount: 42,
        createdAt: new Date(),
        updatedAt: endedAt,
      });
    (prisma.fieldSurveySession.updateMany as Mock).mockResolvedValue({
      count: 1,
    });
    const res = await PATCH(
      makeReq("http://x/api/field-survey/sessions/s-1", {
        method: "PATCH",
        body: JSON.stringify({ status: "ended" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    // updateMany は status="active" 条件付きで呼ばれる (atomicity)
    const umArgs = (prisma.fieldSurveySession.updateMany as Mock).mock
      .calls[0][0];
    expect(umArgs.where).toEqual({ id: "s-1", status: "active" });
    expect(umArgs.data.status).toBe("ended");
    // AuditLog
    const call = writeAuditLog.mock.calls[0][0];
    expect(call.action).toBe("field_survey_session_end");
    expect(call.detail.sessionId).toBe("s-1");
    expect(call.detail.pointCount).toBe(42);
    expect(typeof call.detail.durationSec).toBe("number");
    const s = JSON.stringify(call.detail);
    expect(s).not.toMatch(/lat/i);
    expect(s).not.toMatch(/lng/i);
  });

  it("B-7(@codex R3): 放置 session (最終活動12h超) の終了は endedAt=最終活動時刻・durationSec も過大にしない", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    const startedAt = new Date(Date.now() - 73 * 60 * 60 * 1000); // 73h 前開始
    const lastActivityAt = new Date(Date.now() - 72 * 60 * 60 * 1000); // 72h 前まで活動
    (prisma.fieldSurveySession.findUnique as Mock)
      .mockResolvedValueOnce({
        id: "s-1",
        staffUserId: fieldUser.id,
        startedAt,
        updatedAt: lastActivityAt,
        status: "active",
        pointCount: 5,
      })
      .mockResolvedValueOnce({
        id: "s-1",
        staffUserId: fieldUser.id,
        startedAt,
        endedAt: lastActivityAt,
        status: "ended",
        memo: null,
        pointCount: 5,
        createdAt: startedAt,
        updatedAt: new Date(),
      });
    (prisma.fieldSurveySession.updateMany as Mock).mockResolvedValue({
      count: 1,
    });
    const res = await PATCH(
      makeReq("http://x/api/field-survey/sessions/s-1", {
        method: "PATCH",
        body: JSON.stringify({ status: "ended" }),
      }),
      { params: Promise.resolve({ id: "s-1" }) },
    );
    expect(res.status).toBe(200);
    const umArgs = (prisma.fieldSurveySession.updateMany as Mock).mock
      .calls[0][0];
    expect(umArgs.data.endedAt).toEqual(lastActivityAt);
    // stale 終了は読取時 updatedAt を条件に含める (読取後 flush との race 防止)
    expect(umArgs.where).toEqual({
      id: "s-1",
      status: "active",
      updatedAt: lastActivityAt,
    });
    // durationSec は startedAt→最終活動時刻 (約1時間) で、73時間にはならない
    const call = writeAuditLog.mock.calls[0][0];
    expect(call.detail.durationSec).toBe(60 * 60);
  });

  it("B-7(@codex R4): stale 終了中に flush が入って条件が外れたら 409 INVALID_STATE (監査なし)", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveySession.findUnique as Mock).mockResolvedValue({
      id: "s-1",
      staffUserId: fieldUser.id,
      startedAt: new Date(Date.now() - 73 * 60 * 60 * 1000),
      updatedAt: new Date(Date.now() - 72 * 60 * 60 * 1000),
      status: "active",
      pointCount: 5,
    });
    (prisma.fieldSurveySession.updateMany as Mock).mockResolvedValue({
      count: 0, // 読取後に updatedAt が進んで条件が外れた
    });
    const res = await PATCH(
      makeReq("http://x/api/field-survey/sessions/s-1", {
        method: "PATCH",
        body: JSON.stringify({ status: "ended" }),
      }),
      { params: Promise.resolve({ id: "s-1" }) },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_STATE");
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("B-7(@codex R3): 直前まで活動していた session の通常終了は従来どおり endedAt=now", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    const startedAt = new Date(Date.now() - 60 * 60 * 1000);
    const justNow = new Date(Date.now() - 30 * 1000);
    (prisma.fieldSurveySession.findUnique as Mock)
      .mockResolvedValueOnce({
        id: "s-1",
        staffUserId: fieldUser.id,
        startedAt,
        updatedAt: justNow,
        status: "active",
        pointCount: 5,
      })
      .mockResolvedValueOnce({
        id: "s-1",
        staffUserId: fieldUser.id,
        startedAt,
        endedAt: new Date(),
        status: "ended",
        memo: null,
        pointCount: 5,
        createdAt: startedAt,
        updatedAt: new Date(),
      });
    (prisma.fieldSurveySession.updateMany as Mock).mockResolvedValue({
      count: 1,
    });
    const res = await PATCH(
      makeReq("http://x/api/field-survey/sessions/s-1", {
        method: "PATCH",
        body: JSON.stringify({ status: "ended" }),
      }),
      { params: Promise.resolve({ id: "s-1" }) },
    );
    expect(res.status).toBe(200);
    const umArgs = (prisma.fieldSurveySession.updateMany as Mock).mock
      .calls[0][0];
    // endedAt は updatedAt (30秒前) ではなく now 相当 (直近3秒以内)
    const endedAt = umArgs.data.endedAt as Date;
    expect(Date.now() - endedAt.getTime()).toBeLessThan(3000);
  });

  it("active でない session への終了要求は 409 (updateMany が 0 行)", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveySession.findUnique as Mock).mockResolvedValue({
      id: "s-1",
      staffUserId: fieldUser.id,
      startedAt: new Date(),
      status: "ended", // 既に終了済
      pointCount: 0,
    });
    (prisma.fieldSurveySession.updateMany as Mock).mockResolvedValue({
      count: 0,
    });
    const res = await PATCH(
      makeReq("http://x/api/field-survey/sessions/s-1", {
        method: "PATCH",
        body: JSON.stringify({ status: "ended" }),
      }),
      { params },
    );
    expect(res.status).toBe(409);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("race: 2 並行 end のうち後発は updateMany 0 行で 409 (audit 重複なし)", async () => {
    // findUnique は active を返すが、updateMany 直前に他リクエストが先行して
    // ended にしているケース。後発は 0 行更新 → 409 を返し audit を書かない。
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveySession.findUnique as Mock).mockResolvedValue({
      id: "s-1",
      staffUserId: fieldUser.id,
      startedAt: new Date(),
      status: "active",
      pointCount: 0,
    });
    (prisma.fieldSurveySession.updateMany as Mock).mockResolvedValue({
      count: 0,
    });
    const res = await PATCH(
      makeReq("http://x/api/field-survey/sessions/s-1", {
        method: "PATCH",
        body: JSON.stringify({ status: "ended" }),
      }),
      { params },
    );
    expect(res.status).toBe(409);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("cancel 時の AuditLog detail に位置情報を含まない (updateMany 経由)", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    const startedAt = new Date();
    (prisma.fieldSurveySession.findUnique as Mock)
      .mockResolvedValueOnce({
        id: "s-1",
        staffUserId: fieldUser.id,
        startedAt,
        status: "active",
        pointCount: 0,
      })
      .mockResolvedValueOnce({
        id: "s-1",
        staffUserId: fieldUser.id,
        startedAt,
        endedAt: new Date(),
        status: "cancelled",
        memo: null,
        pointCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    (prisma.fieldSurveySession.updateMany as Mock).mockResolvedValue({
      count: 1,
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

  it("memo のみ更新は updateMany ではなく update を使う / AuditLog を書かない", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    const startedAt = new Date();
    (prisma.fieldSurveySession.findUnique as Mock)
      .mockResolvedValueOnce({
        id: "s-1",
        staffUserId: fieldUser.id,
        startedAt,
        status: "active",
        pointCount: 0,
      })
      .mockResolvedValueOnce({
        id: "s-1",
        staffUserId: fieldUser.id,
        startedAt,
        endedAt: null,
        status: "active",
        memo: "updated",
        pointCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    (prisma.fieldSurveySession.update as Mock).mockResolvedValue({});
    const res = await PATCH(
      makeReq("http://x/api/field-survey/sessions/s-1", {
        method: "PATCH",
        body: JSON.stringify({ memo: "updated" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(prisma.fieldSurveySession.update).toHaveBeenCalledTimes(1);
    expect(prisma.fieldSurveySession.updateMany).not.toHaveBeenCalled();
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

  it("malformed JSON は 400 INVALID_JSON / DB と AuditLog に到達しない", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    const res = await PATCH(
      makeReq("http://x/api/field-survey/sessions/s-1", {
        method: "PATCH",
        body: "{ broken",
      }),
      { params },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_JSON");
    expect(prisma.fieldSurveySession.findUnique).not.toHaveBeenCalled();
    expect(prisma.fieldSurveySession.updateMany).not.toHaveBeenCalled();
    expect(prisma.fieldSurveySession.update).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});

// ============================================================
// GET /api/field-survey/sessions/[id] (Phase 1-J)
// ============================================================
describe("GET /api/field-survey/sessions/[id]", () => {
  const params = Promise.resolve({ id: "s-1" });

  function mockSession(staffUserId: string) {
    (prisma.fieldSurveySession.findUnique as Mock).mockResolvedValue({
      id: "s-1",
      staffUserId,
      startedAt: new Date("2026-05-01T00:00:00Z"),
      endedAt: new Date("2026-05-01T01:00:00Z"),
      status: "ended",
      pointCount: 7,
      staff: { name: "巡回花子" },
    });
    (prisma.fieldSurveyPin.count as Mock).mockResolvedValue(2);
  }

  it("own session を取得でき staffName / pinCount を含む / PII を含まない", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    mockSession(fieldUser.id);
    const res = await GET_DETAIL(makeReq("http://x"), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.staffName).toBe("巡回花子");
    expect(body.data.pinCount).toBe(2);
    expect(body.data.pointCount).toBe(7);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/memo|fileUrl|storageKey|fileName|"lat"|"lng"/i);
    expect(writeAuditLog).not.toHaveBeenCalled();
    // pinCount は archived を除外
    const cWhere = (prisma.fieldSurveyPin.count as Mock).mock.calls[0][0].where;
    expect(cWhere.status).toEqual({ not: "archived" });
  });

  it("他人 session は read のみでは 403", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue([
      { resource: "field_survey", action: "read", granted: true },
    ]);
    mockSession("other-user");
    const res = await GET_DETAIL(makeReq("http://x"), { params });
    expect(res.status).toBe(403);
  });

  it("他人 session は read_all で取得でき AuditLog を残す (PII なし)", async () => {
    (getApiSession as Mock).mockResolvedValue(officeUser);
    (getUserPermissions as Mock).mockResolvedValue(officePerms);
    mockSession("other-user");
    const res = await GET_DETAIL(makeReq("http://x"), { params });
    expect(res.status).toBe(200);
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    const call = (writeAuditLog as Mock).mock.calls[0][0];
    expect(call.action).toBe("field_survey_session_view");
    expect(call.detail).toEqual({
      sessionId: "s-1",
      viewedStaffUserId: "other-user",
      scope: "read_all",
    });
    const serialized = JSON.stringify(call);
    expect(serialized).not.toMatch(/memo|fileUrl|storageKey|fileName|"lat"|"lng"/i);
  });

  it("他人 session は manage でも取得でき scope=manage で監査", async () => {
    (getApiSession as Mock).mockResolvedValue(adminUser);
    (getUserPermissions as Mock).mockResolvedValue(adminPerms);
    mockSession("other-user");
    const res = await GET_DETAIL(makeReq("http://x"), { params });
    expect(res.status).toBe(200);
    const call = (writeAuditLog as Mock).mock.calls[0][0];
    expect(call.detail.scope).toBe("manage");
  });

  it("存在しない session は 404", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue(fieldPerms);
    (prisma.fieldSurveySession.findUnique as Mock).mockResolvedValue(null);
    const res = await GET_DETAIL(makeReq("http://x"), { params });
    expect(res.status).toBe(404);
  });

  it("read 権限なしは 403", async () => {
    (getApiSession as Mock).mockResolvedValue(fieldUser);
    (getUserPermissions as Mock).mockResolvedValue([]);
    const res = await GET_DETAIL(makeReq("http://x"), { params });
    expect(res.status).toBe(403);
  });
});
