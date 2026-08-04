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
// 確定時に「位置記録が持つ最後の記録時刻」を引く (@codex #356 P2)。
const aggregate = vi.fn();

vi.mock("@/lib/prisma", () => ({
  default: {
    fieldSurveySession: {
      findMany: (...a: unknown[]) => findMany(...a),
      updateMany: (...a: unknown[]) => updateMany(...a),
    },
    fieldSurveyTrackPoint: {
      aggregate: (...a: unknown[]) => aggregate(...a),
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
  aggregate.mockReset();
  // 既定は「位置記録なし」（撮って登録だけの巡回）。
  aggregate.mockResolvedValue({ _max: { recordedAt: null } });
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
    expect(body).toMatchObject({ scanned: 0, ended: 0, skipped: 0, settled: 0 });
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("⚠踏破マップへの復帰 (@codex #356 P1)", () => {
  // 自動終了した後に位置記録が届いた巡回は「まだ歩いているかもしれない」ので
  // 踏破マップから外してある。再び無操作1時間を超えたら戻す。
  // ⚠戻す経路が無いと、圏外から復帰した巡回が二度と踏破マップに出ない
  // = 二度歩きを避けるという機能の目的そのものを損なう。
  const pendingSession = {
    id: "sess-pending",
    startedAt: new Date("2026-08-05T00:00:00Z"),
    // 自動終了した時点で記録した終了時刻。
    endedAt: new Date("2026-08-05T01:00:00Z"),
    // 圏外から復帰して記録が届いた時刻（＝終了時刻に使ってはいけない値）。
    updatedAt: new Date("2026-08-05T12:30:00Z"),
  };

  it("再び無操作1時間を超えたら印を外し、終了時刻を最後の活動に直す", async () => {
    findMany
      .mockResolvedValueOnce([]) // 1段目: 新たに自動終了する巡回は無し
      .mockResolvedValueOnce([pendingSession]); // 2段目: 復帰待ちの巡回
    updateMany.mockResolvedValue({ count: 1 });
    const res = await POST(req({ secret: SECRET }));
    const body = await res.json();
    expect(body).toMatchObject({ ended: 0, settled: 1 });

    const args = updateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(args.data).toEqual({
      reconcilePending: false,
      endedAt: pendingSession.endedAt,
    });
    // 読んでから書くまでに記録が届いていたら見送る（次の見回りで拾う）
    expect(args.where).toEqual({
      id: pendingSession.id,
      reconcilePending: true,
      updatedAt: pendingSession.updatedAt,
    });
  });

  it("⚠終了時刻に「届いた時刻」を使わない（歩いた時刻を使う）", async () => {
    // 深夜に歩き終え、翌日の昼に電波が戻って記録が届いたケース。
    // 届いた時刻(updatedAt=12:30)を終了時刻にすると、巡回時間が半日伸び、
    // 踏破の日付も翌日にずれる。
    const walkedUntil = new Date("2026-08-05T01:45:00Z");
    findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([pendingSession]);
    aggregate.mockResolvedValue({ _max: { recordedAt: walkedUntil } });
    updateMany.mockResolvedValue({ count: 1 });
    await POST(req({ secret: SECRET }));
    const args = updateMany.mock.calls[0][0] as { data: { endedAt: Date } };
    expect(args.data.endedAt).toEqual(walkedUntil);
    expect(args.data.endedAt).not.toEqual(pendingSession.updatedAt);
  });

  it("⚠終了時刻を前に戻さない（記録の抜けで巡回時間を縮めない）", async () => {
    const older = new Date("2026-08-05T00:30:00Z"); // 自動終了時刻より前
    findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([pendingSession]);
    aggregate.mockResolvedValue({ _max: { recordedAt: older } });
    updateMany.mockResolvedValue({ count: 1 });
    await POST(req({ secret: SECRET }));
    const args = updateMany.mock.calls[0][0] as { data: { endedAt: Date } };
    expect(args.data.endedAt).toEqual(pendingSession.endedAt);
  });

  it("⚠dryRun では戻さない", async () => {
    findMany.mockResolvedValue([pendingSession]);
    const res = await POST(req({ secret: SECRET, dryRun: true }));
    const body = await res.json();
    expect(body.settled).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("直前に記録が届いていたら戻さない", async () => {
    findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([pendingSession]);
    updateMany.mockResolvedValue({ count: 0 }); // 競合 = まだ歩いている
    const res = await POST(req({ secret: SECRET }));
    const body = await res.json();
    expect(body.settled).toBe(0);
  });
});
