/**
 * 中継サービスへの送信(web-push の包み)。宛先の確かめ直し・時間制限・結果の分け方。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const sendNotification = vi.fn();
vi.mock("web-push", () => ({ default: { sendNotification: (...a: unknown[]) => sendNotification(...a) } }));

import { createWebPushSender, vapidConfig } from "../deliveries/web-push-sender";
import { SEND_TIMEOUT_MS } from "../deliveries/rules";

const VAPID = {
  publicKey: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U",
  privateKey: "UUxI4O8-FbRouAevSmBQ6o18hgE4nSG3qwvJTfKc-ls",
  subject: "mailto:info@example.com",
};
const TARGET = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: "pk", auth: "au" };
const PAYLOAD = { b: "11111111-1111-4111-8111-111111111111", title: "次回対応", body: "今日の次回対応が1件あります", url: "/home", tag: "t" };

beforeEach(() => {
  sendNotification.mockReset();
  vi.useRealTimers();
});

describe("VAPID の鍵", () => {
  it("3つそろって形が正しいときだけ使う", () => {
    const env = { VAPID_PUBLIC_KEY: VAPID.publicKey, VAPID_PRIVATE_KEY: VAPID.privateKey, VAPID_SUBJECT: VAPID.subject } as unknown as NodeJS.ProcessEnv;
    expect(vapidConfig(env)).toEqual(VAPID);
    expect(vapidConfig({ ...env, VAPID_SUBJECT: "" })).toBeNull();
    expect(vapidConfig({ ...env, VAPID_SUBJECT: "info@example.com" })).toBeNull();
    expect(vapidConfig({ ...env, VAPID_PRIVATE_KEY: "short" })).toBeNull();
  });
});

describe("送信", () => {
  it("許可リスト外の宛先には接続しない(送信時にも確かめる)", async () => {
    const send = createWebPushSender(VAPID);
    const r = await send({ ...TARGET, endpoint: "https://evil.example/x" }, PAYLOAD);
    expect(r).toEqual({ ok: false, gone: false, code: "endpoint_not_allowed" });
    expect(sendNotification).not.toHaveBeenCalled();
  });
  it("本文は結び付け・種類と件数だけ・10秒の時間制限・短い預け時間で送る", async () => {
    sendNotification.mockResolvedValue({ statusCode: 201 });
    const r = await createWebPushSender(VAPID)(TARGET, PAYLOAD);
    expect(r).toEqual({ ok: true });
    const [sub, body, opts] = sendNotification.mock.calls[0];
    expect(sub).toEqual({ endpoint: TARGET.endpoint, keys: { p256dh: "pk", auth: "au" } });
    expect(JSON.parse(body)).toEqual(PAYLOAD);
    expect(opts).toMatchObject({ timeout: SEND_TIMEOUT_MS, TTL: 7200, urgency: "normal", vapidDetails: VAPID });
  });
  it("410 は gone・応答本文や宛先は結果に出さない", async () => {
    sendNotification.mockRejectedValue(Object.assign(new Error("Received unexpected response code"), { statusCode: 410, body: "secret-body", endpoint: TARGET.endpoint }));
    const r = await createWebPushSender(VAPID)(TARGET, PAYLOAD);
    expect(r).toEqual({ ok: false, gone: true, code: "http_410" });
    expect(JSON.stringify(r)).not.toContain("secret-body");
    expect(JSON.stringify(r)).not.toContain("fcm.googleapis.com");
  });
  it("応答が返らなくても10秒で諦める(送り直しへ)", async () => {
    vi.useFakeTimers();
    sendNotification.mockReturnValue(new Promise(() => {}));
    const p = createWebPushSender(VAPID)(TARGET, PAYLOAD);
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS + 1);
    expect(await p).toEqual({ ok: false, gone: false, code: "timeout" });
  });
});
