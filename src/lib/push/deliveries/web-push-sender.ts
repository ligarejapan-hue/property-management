/**
 * 中継サービスへの送信(web-push)。宛先は送る直前にも許可リストで確かめる(設計書 §7.2)。
 * ⚠endpoint・鍵・中継サービスの応答本文はログ・戻り値に出さない(定型コードだけ返す)。
 * web-push は HTTP のリダイレクトを追わない(https.request をそのまま使う)。
 */
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

export function createWebPushSender(vapid: VapidConfig): PushSender {
  return async (target, payload) => {
    if (!checkPushEndpoint(target.endpoint).ok) return { ok: false, gone: false, code: "endpoint_not_allowed" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const send = webpush.sendNotification(
        { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
        JSON.stringify(payload),
        {
          vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
          TTL: PUSH_TTL_SECONDS,
          urgency: "normal",
          timeout: SEND_TIMEOUT_MS,
        },
      );
      // 接続が止まったままでも10秒で諦める(ソケットの無通信だけでなく全体の時間で切る)。
      const limit = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("push_timeout")), SEND_TIMEOUT_MS);
      });
      await Promise.race([send, limit]);
      return { ok: true };
    } catch (e) {
      return { ok: false, ...classifySendError(e) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
