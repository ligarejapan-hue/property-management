import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("next/server", async () => (await import("./agent-inquiry-route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./agent-inquiry-route-mocks")).apiHelpersMock());
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
const svc = vi.hoisted(() => ({
  upsertPushSubscription: vi.fn(),
  revokePushSubscription: vi.fn(async () => true),
  extendPushSubscription: vi.fn(async () => true),
}));
vi.mock("@/lib/push/subscriptions", async (orig) => ({
  ...(await orig<typeof import("@/lib/push/subscriptions")>()),
  ...svc,
}));

import { getApiSession } from "@/lib/api-helpers";
import { GET as CONFIG } from "../../app/api/push/config/route";
import { PUT, DELETE } from "../../app/api/push/subscription/route";
import { POST as EXTEND } from "../../app/api/push/subscription/extend/route";

type Fn = ReturnType<typeof vi.fn>;
const U = "11111111-1111-4111-8111-111111111111";
const EP = "https://fcm.googleapis.com/fcm/send/secret-token";
const PUB = "B" + "x".repeat(86);
const req = (method: string, body: unknown) =>
  new Request("http://x/api/push/subscription", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) as never;
const saved = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: U, role: "office_staff" });
  process.env.VAPID_PUBLIC_KEY = PUB;
  process.env.VAPID_PRIVATE_KEY = "priv";
  process.env.VAPID_SUBJECT = "mailto:info@example.com";
  svc.upsertPushSubscription.mockResolvedValue({ bindingId: "b-1", deviceScope: "shared", expiresAt: new Date("2026-10-03T04:05:00Z"), rebound: true });
});
afterEach(() => {
  for (const k of ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("プッシュの登録 API(段階4a)", () => {
  it("公開鍵を返す・鍵がそろわなければ使えない", async () => {
    expect(await (await CONFIG()).json()).toEqual({ enabled: true, publicKey: PUB });
    delete process.env.VAPID_PRIVATE_KEY;
    expect(await (await CONFIG()).json()).toEqual({ enabled: false, publicKey: null });
  });
  it("鍵がそろっていなければ登録は 501(準備中)", async () => {
    delete process.env.VAPID_SUBJECT;
    expect((await PUT(req("PUT", { endpoint: EP, keys: { p256dh: "x", auth: "y" } }))).status).toBe(501);
    expect(svc.upsertPushSubscription).not.toHaveBeenCalled();
  });
  it("登録の応答は結び付け・範囲・期限だけ(endpoint・鍵を返さない)・監査にも出さない", async () => {
    const res = await PUT(req("PUT", { endpoint: EP, keys: { p256dh: "pk", auth: "au" }, deviceScope: "personal" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ bindingId: "b-1", deviceScope: "shared", expiresAt: "2026-10-03T04:05:00.000Z" });
    expect(svc.upsertPushSubscription).toHaveBeenCalledWith(U, { endpoint: EP, p256dh: "pk", auth: "au", deviceScope: "personal" });
    const audit = JSON.stringify(writeAuditLog.mock.calls);
    expect(audit).not.toContain("secret-token");
    expect(audit).not.toContain("pk");
    expect(audit).toContain("push_subscription_register");
  });
  it("範囲は shared / personal だけ", async () => {
    expect((await PUT(req("PUT", { endpoint: EP, keys: { p256dh: "pk", auth: "au" }, deviceScope: "admin" }))).status).toBe(422);
  });
  it("登録の途中の取り消しは、結び付けを添えて「その結び付けのときだけ」解除する", async () => {
    await DELETE(req("DELETE", { endpoint: EP, bindingId: "11111111-1111-4111-8111-11111111111A", reason: "cancelled" }));
    expect(svc.revokePushSubscription).toHaveBeenLastCalledWith(U, EP, expect.any(Date), {
      bindingId: "11111111-1111-4111-8111-11111111111a",
      reason: "cancelled",
    });
    expect((await DELETE(req("DELETE", { endpoint: EP, bindingId: "x" }))).status).toBe(422);
    expect((await DELETE(req("DELETE", { endpoint: EP, reason: "gone" }))).status).toBe(422);
  });
  it("解除・延長は自分の登録に対して行う(サービスに利用者 ID を渡す)", async () => {
    await DELETE(req("DELETE", { endpoint: EP }));
    expect(svc.revokePushSubscription).toHaveBeenCalledWith(U, EP, expect.any(Date), { bindingId: undefined, reason: "logout" });
    const res = await EXTEND(req("POST", { endpoint: EP }));
    expect(await res.json()).toEqual({ active: true });
    expect(svc.extendPushSubscription).toHaveBeenCalledWith(U, EP);
  });
});
