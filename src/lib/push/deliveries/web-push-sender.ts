/**
 * 中継サービスへの送信(web-push)。宛先は送る直前にも許可リストで確かめる(設計書 §7.2)。
 * ⚠endpoint・鍵・中継サービスの応答本文はログ・戻り値に出さない(定型コードだけ返す)。
 *
 * 暗号化と VAPID の署名は web-push の `generateRequestDetails` に任せ、送信そのものはここで行う
 * (@codex #472 P2): web-push の送信は外から止められず、時間切れで諦めても裏で届いてしまい、
 * 送り直しで2通になるため。ここでは時間切れで**要求そのものを壊し、終わるのを待ってから**返す。
 * HTTP のリダイレクトは追わない(https.request をそのまま使う)。
 */
import https from "node:https";
import webpush from "web-push";
import { checkPushEndpoint } from "@/lib/push/endpoint";
import { classifySendError, PUSH_TTL_SECONDS, SEND_TIMEOUT_MS, type PushPayload, type SendOutcome } from "./rules";

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type PushSender = (target: PushTarget, payload: PushPayload) => Promise<SendOutcome>;

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/** VAPID の鍵3つ。そろっていなければ null(送らない)。 */
export function vapidConfig(env: NodeJS.ProcessEnv = process.env): VapidConfig | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  const subject = env.VAPID_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  if (!/^[A-Za-z0-9_-]{40,200}$/.test(publicKey) || !/^[A-Za-z0-9_-]{20,100}$/.test(privateKey)) return null;
  if (!/^(mailto:|https:\/\/)/.test(subject)) return null;
  return { publicKey, privateKey, subject };
}

export interface RequestDetails {
  method: string;
  headers: Record<string, string | number>;
  body: Buffer | null;
  endpoint: string;
}

type RequestFn = (url: URL, options: https.RequestOptions, cb: (res: import("node:http").IncomingMessage) => void) => import("node:http").ClientRequest;

/**
 * 1回の HTTP 要求。`timeoutMs` を過ぎたら要求を壊し(接続の途中でも)、終わるのを待ってから失敗を返す。
 * 2xx 以外は `statusCode` 付きで失敗にする(応答本文は読み捨てる=どこにも残さない)。
 */
export function sendRequest(details: RequestDetails, timeoutMs: number, request: RequestFn = https.request): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const req = request(new URL(details.endpoint), { method: details.method, headers: details.headers }, (res) => {
      res.resume();
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        finish(status >= 200 && status <= 299 ? undefined : Object.assign(new Error("push_http_error"), { statusCode: status }));
      });
      res.on("error", (e) => finish(e));
    });
    // 時間切れは要求を壊す。壊したあとの error/close を待ってから返す(裏で送られ続けない)。
    const timer = setTimeout(() => req.destroy(new Error("push_timeout")), timeoutMs);
    req.on("error", (e) => finish(e));
    // 応答の終わり(end)と要求の close が同じ順番で来ることに頼らない(end を先に処理させる)。
    req.on("close", () => setImmediate(() => finish(new Error("push_closed"))));
    req.end(details.body ?? undefined);
  });
}

export function createWebPushSender(vapid: VapidConfig, request: RequestFn = https.request): PushSender {
  return async (target, payload) => {
    if (!checkPushEndpoint(target.endpoint).ok) return { ok: false, gone: false, code: "endpoint_not_allowed" };
    try {
      const details = webpush.generateRequestDetails(
        { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
        JSON.stringify(payload),
        {
          vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
          TTL: PUSH_TTL_SECONDS,
          urgency: "normal",
        },
      ) as unknown as RequestDetails;
      // 送る先は web-push が組み立てた URL。念のためもう一度許可リストで確かめる。
      if (!checkPushEndpoint(details.endpoint).ok) return { ok: false, gone: false, code: "endpoint_not_allowed" };
      await sendRequest(details, SEND_TIMEOUT_MS, request);
      return { ok: true };
    } catch (e) {
      return { ok: false, ...classifySendError(e) };
    }
  };
}
