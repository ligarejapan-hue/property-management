import nodemailer from "nodemailer";
import type { MailSendConfig } from "./mail-config";

export interface PlainMail {
  to: string;
  subject: string;
  text: string;
}
export type SendResult = { ok: true } | { ok: false; code: string | null };

type Sender = (config: MailSendConfig, mail: PlainMail) => Promise<void>;
let senderOverride: Sender | null = null;

// テスト専用の差し替え口(本番コードから呼ばない)。
export function setMailSenderForTest(fn: Sender | null): void {
  senderOverride = fn;
}

const CODE_RE = /^[A-Z][A-Z0-9_]{1,40}$/;
export function safeErrorCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && CODE_RE.test(code) ? code : null;
}

const realSender: Sender = async (config, mail) => {
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    // STARTTLS(secure=false)は「機会的アップグレード」任せにしない。
    // サーバーが STARTTLS を広告しない(または攻撃者に剥がされた)場合は
    // 平文のまま送らず、必ず失敗させる(fail closed)。
    requireTLS: !config.secure,
    auth: { user: config.user, pass: config.pass },
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  await transporter.sendMail({ from: config.from, to: mail.to, subject: mail.subject, text: mail.text });
};

// 1通送る。throw しない。件名の改行は除く(ヘッダ注入の多層防御)。
// ⚠失敗の message は SMTP 応答・宛先を含み得るので出さない(name/code の許可リストだけ)。
export async function sendPlainMail(config: MailSendConfig, mail: PlainMail): Promise<SendResult> {
  const safe: PlainMail = { to: mail.to, subject: mail.subject.replace(/[\r\n]+/g, ""), text: mail.text };
  try {
    await (senderOverride ?? realSender)(config, safe);
    return { ok: true };
  } catch (err) {
    const code = safeErrorCode(err);
    console.error("[mail] send failed", { name: err instanceof Error ? err.name : "Unknown", code });
    return { ok: false, code };
  }
}
