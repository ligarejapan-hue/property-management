/**
 * 中継サービスへの送信(web-push の包み)。宛先の確かめ直し・時間切れで要求を壊すこと・結果の分け方。
 * 送信は手元の HTTP サーバーへ向けて本物の要求を流して確かめる(暗号化・署名は web-push の作り物)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

const generateRequestDetails = vi.fn();
vi.mock("web-push", () => ({ default: { generateRequestDetails: (...a: unknown[]) => generateRequestDetails(...a) } }));

import { createWebPushSender, sendRequest, vapidConfig, type RequestDetails } from "../deliveries/web-push-sender";

const VAPID = {
  publicKey: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U",
  privateKey: "UUxI4O8-FbRouAevSmBQ6o18hgE4nSG3qwvJTfKc-ls",
  subject: "mailto:info@example.com",
};
const TARGET = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: "pk", auth: "au" };
const PAYLOAD = { b: "11111111-1111-4111-8111-111111111111", title: "次回対応", body: "今日の次回対応が1件あります", url: "/home", tag: "t" };

// ---- 手元の HTTP サーバー(応答の仕方をテストごとに決める) ----
type Mode = { status?: number; hang?: boolean };
let mode: Mode = {};
let server: http.Server;
let port = 0;
let serverSawClose = 0;
let received: Array<{ method?: string; headers: http.IncomingHttpHeaders; body: string }> = [];

beforeEach(async () => {
  mode = {};
  serverSawClose = 0;
  received = [];
  generateRequestDetails.mockReset();
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ method: req.method, headers: req.headers, body });
      if (mode.hang) return; // 返事をしない
      res.statusCode = mode.status ?? 201;
      res.end("secret-response-body");
    });
    req.socket.on("close", () => (serverSawClose += 1));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

/** 本物の宛先 URL のまま、つなぐ先だけ手元のサーバーにする。 */
const localRequest = (url: URL, options: http.RequestOptions, cb: (res: http.IncomingMessage) => void) =>
  http.request({ host: "127.0.0.1", port, path: url.pathname, method: options.method, headers: options.headers }, cb);

const details = (over: Partial<RequestDetails> = {}): RequestDetails => ({
  method: "POST",
  headers: { TTL: 7200, Urgency: "normal", "Content-Encoding": "aes128gcm" },
  body: Buffer.from("encrypted"),
  endpoint: TARGET.endpoint,
  ...over,
});

describe("VAPID の鍵", () => {
  it("3つそろって形が正しいときだけ使う", () => {
    const env = { VAPID_PUBLIC_KEY: VAPID.publicKey, VAPID_PRIVATE_KEY: VAPID.privateKey, VAPID_SUBJECT: VAPID.subject } as unknown as NodeJS.ProcessEnv;
    expect(vapidConfig(env)).toEqual(VAPID);
    expect(vapidConfig({ ...env, VAPID_SUBJECT: "" })).toBeNull();
    expect(vapidConfig({ ...env, VAPID_SUBJECT: "info@example.com" })).toBeNull();
    expect(vapidConfig({ ...env, VAPID_PRIVATE_KEY: "short" })).toBeNull();
  });
  it("長さだけ合っている鍵・組になっていない鍵は使わない(記録を作る前に 503)", () => {
    const env = { VAPID_PUBLIC_KEY: VAPID.publicKey, VAPID_PRIVATE_KEY: VAPID.privateKey, VAPID_SUBJECT: VAPID.subject } as unknown as NodeJS.ProcessEnv;
    // 文字数は同じだが P-256 の公開鍵ではない(先頭が 0x04 でない)
    expect(vapidConfig({ ...env, VAPID_PUBLIC_KEY: "A" + VAPID.publicKey.slice(1) })).toBeNull();
    // 形は正しいが別の秘密鍵(公開鍵と組にならない)
    const other = Buffer.alloc(32, 7).toString("base64url");
    expect(vapidConfig({ ...env, VAPID_PRIVATE_KEY: other })).toBeNull();
    // 32バイトでない秘密鍵
    expect(vapidConfig({ ...env, VAPID_PRIVATE_KEY: VAPID.privateKey + "AA" })).toBeNull();
  });
});

describe("1回の HTTP 要求(sendRequest)", () => {
  it("2xx で成功・本文と見出しをそのまま送る", async () => {
    await sendRequest(details(), 2000, localRequest);
    expect(received[0]).toMatchObject({ method: "POST", body: "encrypted" });
    expect(received[0].headers.ttl).toBe("7200");
  });
  it("2xx 以外は statusCode 付きで失敗(応答本文は持ち出さない)", async () => {
    mode.status = 410;
    const err = await sendRequest(details(), 2000, localRequest).catch((e) => e);
    expect(err.statusCode).toBe(410);
    expect(JSON.stringify({ m: err.message, s: err.statusCode })).not.toContain("secret-response-body");
  });
  it("時間切れでは要求そのものを壊し、壊れ終わってから失敗を返す(裏で送られ続けない)", async () => {
    mode.hang = true;
    const t0 = Date.now();
    const err = await sendRequest(details(), 200, localRequest).catch((e) => e);
    expect(err.message).toBe("push_timeout");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190);
    await new Promise((r) => setTimeout(r, 50));
    expect(serverSawClose).toBeGreaterThanOrEqual(1);
  });
});

describe("送信(createWebPushSender)", () => {
  it("許可リスト外の宛先には接続しない(送信時にも確かめる)", async () => {
    const r = await createWebPushSender(VAPID, localRequest)({ ...TARGET, endpoint: "https://evil.example/x" }, PAYLOAD);
    expect(r).toEqual({ ok: false, gone: false, code: "endpoint_not_allowed" });
    expect(generateRequestDetails).not.toHaveBeenCalled();
    expect(received).toHaveLength(0);
  });
  it("本文は結び付け・種類と件数だけ・短い預け時間で暗号化を頼み、送る", async () => {
    generateRequestDetails.mockReturnValue(details());
    const r = await createWebPushSender(VAPID, localRequest)(TARGET, PAYLOAD);
    expect(r).toEqual({ ok: true });
    const [sub, body, opts] = generateRequestDetails.mock.calls[0];
    expect(sub).toEqual({ endpoint: TARGET.endpoint, keys: { p256dh: "pk", auth: "au" } });
    expect(JSON.parse(body)).toEqual(PAYLOAD);
    expect(opts).toMatchObject({ TTL: 7200, urgency: "normal", vapidDetails: VAPID });
    expect(received).toHaveLength(1);
  });
  it("組み立てた宛先が許可リスト外なら送らない", async () => {
    generateRequestDetails.mockReturnValue(details({ endpoint: "https://evil.example/x" }));
    const r = await createWebPushSender(VAPID, localRequest)(TARGET, PAYLOAD);
    expect(r).toEqual({ ok: false, gone: false, code: "endpoint_not_allowed" });
    expect(received).toHaveLength(0);
  });
  it("410 は gone・応答本文や宛先は結果に出さない", async () => {
    generateRequestDetails.mockReturnValue(details());
    mode.status = 410;
    const r = await createWebPushSender(VAPID, localRequest)(TARGET, PAYLOAD);
    expect(r).toEqual({ ok: false, gone: true, code: "http_410" });
    expect(JSON.stringify(r)).not.toContain("secret-response-body");
    expect(JSON.stringify(r)).not.toContain("fcm.googleapis.com");
  });
  it("500 は送り直し(gone にしない)", async () => {
    generateRequestDetails.mockReturnValue(details());
    mode.status = 500;
    expect(await createWebPushSender(VAPID, localRequest)(TARGET, PAYLOAD)).toEqual({ ok: false, gone: false, code: "http_500" });
  });
});
