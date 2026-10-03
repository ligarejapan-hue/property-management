/**
 * Web プッシュの送信の実行口(timer 用・通知 段階4b)の挙動。合言葉・鍵の有無・応答に宛先が無いこと。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const run = vi.fn();
vi.mock("@/lib/push/deliveries/run", () => ({ runPushNotifications: (...a: unknown[]) => run(...a) }));
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

const SECRET = "push-run-secret-value";
const VAPID = {
  VAPID_PUBLIC_KEY: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U",
  VAPID_PRIVATE_KEY: "UUxI4O8-FbRouAevSmBQ6o18hgE4nSG3qwvJTfKc-ls",
  VAPID_SUBJECT: "mailto:info@example.com",
};
const KEYS = ["NOTIFICATIONS_PUSH_RUN_SECRET", ...Object.keys(VAPID)] as const;
const saved: Record<string, string | undefined> = {};
const req = (secret?: string) =>
  new Request("http://localhost/api/notifications/push-run", {
    method: "POST",
    headers: secret === undefined ? {} : { "x-push-run-secret": secret },
  });

beforeEach(() => {
  run.mockReset();
  run.mockResolvedValue({ planned: { nextAction: 1, inquiry: 0, registryJob: 0 }, sent: { sent: 1 }, purged: { deliveries: 0, events: 0 } });
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("POST /api/notifications/push-run", () => {
  it("合言葉が未設定なら 503(休眠)・何も送らない", async () => {
    Object.assign(process.env, VAPID);
    const res = await POST(req(SECRET));
    expect(res.status).toBe(503);
    expect(run).not.toHaveBeenCalled();
  });
  it("合言葉が違う・無いと 403", async () => {
    Object.assign(process.env, VAPID, { NOTIFICATIONS_PUSH_RUN_SECRET: SECRET });
    expect((await POST(req("wrong"))).status).toBe(403);
    expect((await POST(req())).status).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });
  it("VAPID の鍵がそろっていなければ 503(送らずに失敗で終わる=timer の失敗で気づける)", async () => {
    process.env.NOTIFICATIONS_PUSH_RUN_SECRET = SECRET;
    process.env.VAPID_PUBLIC_KEY = VAPID.VAPID_PUBLIC_KEY;
    const res = await POST(req(SECRET));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: "PUSH_NOT_CONFIGURED" });
    expect(run).not.toHaveBeenCalled();
  });
  it("そろっていれば1回分を実行し、件数だけ返す", async () => {
    Object.assign(process.env, VAPID, { NOTIFICATIONS_PUSH_RUN_SECRET: SECRET });
    const res = await POST(req(SECRET));
    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
    expect(await res.json()).toEqual({ planned: { nextAction: 1, inquiry: 0, registryJob: 0 }, sent: { sent: 1 }, purged: { deliveries: 0, events: 0 } });
  });
  it("実行中の失敗(カーソルが無い等)は 500 で返す(timer の失敗になる)", async () => {
    Object.assign(process.env, VAPID, { NOTIFICATIONS_PUSH_RUN_SECRET: SECRET });
    run.mockRejectedValue(new Error("notification_source_cursor_missing"));
    expect((await POST(req(SECRET))).status).toBe(500);
  });
  it("timer から呼べるよう認証の手前で通す(完全一致だけ)", () => {
    expect(isPublicPath("/api/notifications/push-run")).toBe(true);
    expect(isPublicPath("/api/notifications/push-run-x")).toBe(false);
    expect(isPublicPath("/api/notifications/summary")).toBe(false);
  });
  it("nginx の雛形で、外からは送信の口を 404 にする(timer は 127.0.0.1 を直接呼ぶ)", () => {
    const conf = readFileSync(resolve(__dirname, "../../../../../../deploy/nginx/property-management.conf.example"), "utf-8");
    expect(conf).toMatch(/location = \/api\/notifications\/push-run \{\s*return 404;\s*\}/);
    const unit = readFileSync(resolve(__dirname, "../../../../../../deploy/systemd/pm-push-notify.service.example"), "utf-8");
    expect(unit).toContain("http://127.0.0.1:3000/api/notifications/push-run");
  });
  it("timer は前回が終わってから2分(始まりからだと、長引いた回のあと二度と動かなくなる)", () => {
    const timer = readFileSync(resolve(__dirname, "../../../../../../deploy/systemd/pm-push-notify.timer.example"), "utf-8");
    expect(timer).toMatch(/^OnUnitInactiveSec=2min$/m);
    expect(timer).not.toMatch(/^OnUnitActiveSec=/m);
  });
  it("アプリのプロセスの中に常駐のタイマーを置かない(設計書 §7.3)", () => {
    for (const f of ["run.ts", "plan.ts", "send.ts", "web-push-sender.ts", "eligibility.ts", "rules.ts"]) {
      const src = readFileSync(resolve(__dirname, "../../../../../lib/push/deliveries", f), "utf-8");
      expect(src, f).not.toMatch(/setInterval\(/);
    }
  });
});
