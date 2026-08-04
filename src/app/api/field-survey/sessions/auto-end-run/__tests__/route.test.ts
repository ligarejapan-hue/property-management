/**
 * 巡回の自動終了 route の**挙動**テスト (@codex #356 P2)。
 *
 * ⚠ソースを文字列一致で見るだけのテストでは、**壊れる変更が緑のまま通る**。
 * これは巡回を終了させる=データを書き換える口なので、実際に POST を呼んで
 * 「合言葉・dry-run・競合・監査」を確かめる。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const findMany = vi.fn();
const updateMany = vi.fn();
const auditLog = vi.fn();

vi.mock("@/lib/prisma", () => ({
  default: {
    fieldSurveySession: {
      findMany: (...a: unknown[]) => findMany(...a),
      updateMany: (...a: unknown[]) => updateMany(...a),
    },
  },
}));
vi.mock("@/lib/audit", () => ({
  writeAuditLog: (...a: unknown[]) => auditLog(...a),
}));
vi.mock("@/lib/api-helpers", async () => {
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
    apiResponse: (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status }),
    handleApiError: (e: unknown) => {
      const err = e as { status?: number; message?: string };
      return new Response(JSON.stringify({ error: err.message }), {
        status: err.status ?? 500,
      });
    },
  };
});

import { POST } from "../route";

const SECRET = "test-secret-value";
const req = (opts?: { secret?: string; dryRun?: boolean }) =>
  new Request(
    `http://localhost/api/field-survey/sessions/auto-end-run${opts?.dryRun ? "?dryRun=1" : ""}`,
    {
      method: "POST",
      headers: opts?.secret ? { "x-auto-end-secret": opts.secret } : {},
    },
  );

const staleSession = {
  id: "sess-1",
  staffUserId: "staff-1",
  startedAt: new Date("2026-08-05T08:00:00+09:00"),
  updatedAt: new Date("2026-08-05T08:30:00+09:00"),
  pointCount: 12,
};

beforeEach(() => {
  findMany.mockReset();
  updateMany.mockReset();
  auditLog.mockReset();
  process.env.FIELD_SURVEY_AUTO_END_SECRET = SECRET;
});
afterEach(() => {
  delete process.env.FIELD_SURVEY_AUTO_END_SECRET;
});

describe("合言葉", () => {
  it("⚠未設定なら 503 で、DB を一切触らない", async () => {
    delete process.env.FIELD_SURVEY_AUTO_END_SECRET;
    const res = await POST(req({ secret: SECRET }));
    expect(res.status).toBe(503);
    expect(findMany).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("⚠合言葉が違えば 403 で、DB を一切触らない", async () => {
    const res = await POST(req({ secret: "wrong-secret-xx" }));
    expect(res.status).toBe(403);
    expect(findMany).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("合言葉が無くても 403", async () => {
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("dryRun", () => {
  it("⚠件数だけ返し、1件も終了させない", async () => {
    findMany.mockResolvedValue([staleSession]);
    const res = await POST(req({ secret: SECRET, dryRun: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scanned).toBe(1);
    expect(body.ended).toBe(0);
    expect(body.dryRun).toBe(true);
    expect(updateMany).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });
});

describe("終了の実行", () => {
  it("終了させ、監査に残す", async () => {
    findMany.mockResolvedValue([staleSession]);
    updateMany.mockResolvedValue({ count: 1 });
    const res = await POST(req({ secret: SECRET }));
    const body = await res.json();
    expect(body.ended).toBe(1);
    expect(body.skipped).toBe(0);

    // ⚠終了時刻は「気づいた時刻」ではなく最後に活動した時刻
    const args = updateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: { endedAt: Date };
    };
    expect(args.data.endedAt).toEqual(staleSession.updatedAt);
    // ⚠読んだ時点の updatedAt を条件に含める(競合ガード)
    expect(args.where).toMatchObject({
      id: staleSession.id,
      status: "active",
      updatedAt: staleSession.updatedAt,
    });

    // ⚠担当者を実行者にしない(本人がやっていない操作を本人の記録にしない)
    const audit = auditLog.mock.calls[0][0] as {
      userId: string | null;
      detail: Record<string, unknown>;
    };
    expect(audit.userId).toBeNull();
    expect(audit.detail.ownerStaffUserId).toBe(staleSession.staffUserId);
    expect(audit.detail.reason).toBe("idle_timeout");
  });

  it("⚠直前に活動があったら終了させず、監査も残さない", async () => {
    findMany.mockResolvedValue([staleSession]);
    updateMany.mockResolvedValue({ count: 0 }); // 競合 = まだ歩いている
    const res = await POST(req({ secret: SECRET }));
    const body = await res.json();
    expect(body.ended).toBe(0);
    expect(body.skipped).toBe(1);
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("対象が無ければ何もしない", async () => {
    findMany.mockResolvedValue([]);
    const res = await POST(req({ secret: SECRET }));
    const body = await res.json();
    expect(body).toMatchObject({ scanned: 0, ended: 0, skipped: 0 });
    expect(updateMany).not.toHaveBeenCalled();
  });
});
