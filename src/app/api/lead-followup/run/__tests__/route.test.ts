/**
 * 追客メールの送信の実行口(timer 用)。合言葉・休眠・応答に宛先が無いこと・公開パス・nginx・timer の例。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

const run = vi.fn();
vi.mock("@/lib/lead-followup/run", () => ({ runLeadFollowups: (...a: unknown[]) => run(...a) }));
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
    apiResponse: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
    handleApiError: (e: unknown) => {
      const err = e as { status?: number; code?: string };
      return new Response(JSON.stringify({ code: err.code }), { status: err.status ?? 500 });
    },
  };
});

import { POST } from "../route";
import { isPublicPath } from "@/proxy";

const SECRET = "lead-followup-run-secret-value";
const saved = process.env.LEAD_FOLLOWUP_RUN_SECRET;
const req = (secret?: string) =>
  new Request("http://localhost/api/lead-followup/run", {
    method: "POST",
    headers: secret === undefined ? {} : { "x-lead-followup-run-secret": secret },
  });

beforeEach(() => {
  run.mockReset();
  run.mockResolvedValue({ enabled: true, ready: true, sent: 2, failed: 0 });
  delete process.env.LEAD_FOLLOWUP_RUN_SECRET;
});
afterEach(() => {
  if (saved === undefined) delete process.env.LEAD_FOLLOWUP_RUN_SECRET;
  else process.env.LEAD_FOLLOWUP_RUN_SECRET = saved;
});

describe("POST /api/lead-followup/run", () => {
  it("合言葉が未設定なら 503(休眠・何もしない)", async () => {
    const res = await POST(req(SECRET));
    expect(res.status).toBe(503);
    expect(run).not.toHaveBeenCalled();
  });

  it("合言葉が無い・違う(長さ違いも)なら 403", async () => {
    process.env.LEAD_FOLLOWUP_RUN_SECRET = SECRET;
    for (const s of [undefined, "", "wrong", `${SECRET}x`]) {
      expect((await POST(req(s))).status).toBe(403);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("合っていれば1回分を実行し、件数だけを返す(持ち時間つき)", async () => {
    process.env.LEAD_FOLLOWUP_RUN_SECRET = SECRET;
    const before = Date.now();
    const res = await POST(req(SECRET));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, ready: true, sent: 2, failed: 0 });
    const [now, opts] = run.mock.calls[0] as [Date, { deadline: number }];
    expect(now).toBeInstanceOf(Date);
    expect(opts.deadline).toBeGreaterThanOrEqual(before + 150_000);
    expect(opts.deadline).toBeLessThan(before + 200_000);
  });

  it("ログインなしで届く公開パスに入っている(無いと 307)", () => {
    expect(isPublicPath("/api/lead-followup/run")).toBe(true);
  });

  it("nginx の例で外からは 404・timer の例は合言葉を標準入力で渡し、前回の終わりから15分", () => {
    const nginx = readFileSync("deploy/nginx/property-management.conf.example", "utf8");
    expect(nginx).toMatch(/location = \/api\/lead-followup\/run \{\s*return 404;\s*\}/);
    const service = readFileSync("deploy/systemd/pm-lead-followup.service.example", "utf8");
    expect(service).toContain("x-lead-followup-run-secret: $LEAD_FOLLOWUP_RUN_SECRET");
    expect(service).toContain("-H @-");
    expect(service).toContain("http://127.0.0.1:3000/api/lead-followup/run");
    expect(service).toContain("--max-time 240");
    const timer = readFileSync("deploy/systemd/pm-lead-followup.timer.example", "utf8");
    expect(timer).toMatch(/^OnUnitInactiveSec=15min$/m);
    expect(timer).not.toMatch(/^OnUnitActiveSec/m);
  });
});
