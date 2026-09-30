import prisma from "@/lib/prisma";
import { decryptSecret } from "@/lib/sale-dm-letter/secret-crypto";

export const MAIL_CONFIG_ID = "singleton";
export type InquiryMailDetail = "minimal" | "full";

export interface MailSendConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  appBaseUrl: string | null;
  inquiryMailDetail: InquiryMailDetail;
}

export function isMailConfigComplete(
  row: { smtpHost: string | null; smtpPort: number | null; smtpUser: string | null; smtpPassEnc: string | null; fromAddress: string | null } | null,
): boolean {
  return !!row && !!row.smtpHost && !!row.smtpPort && !!row.smtpUser && !!row.smtpPassEnc && !!row.fromAddress;
}

export interface InquiryAutoReplySettings {
  enabled: boolean;
  subject: string | null;
  body: string | null;
}

// 申込者への受付メール(自動返信)のスイッチと文面。行が無い・DB 例外は OFF(安全側=送らない)。
export async function loadInquiryAutoReplySettings(): Promise<InquiryAutoReplySettings> {
  try {
    const row = await prisma.mailConfig.findUnique({
      where: { id: MAIL_CONFIG_ID },
      select: { inquiryAutoReplyEnabled: true, inquiryAutoReplySubject: true, inquiryAutoReplyBody: true },
    });
    if (!row) return { enabled: false, subject: null, body: null };
    return { enabled: row.inquiryAutoReplyEnabled === true, subject: row.inquiryAutoReplySubject, body: row.inquiryAutoReplyBody };
  } catch {
    return { enabled: false, subject: null, body: null };
  }
}

// 送信に使う設定(パスワード復号込み)。未完成・復号失敗・DB 例外は null(呼び出し側は mail_not_configured)。
// ⚠この戻り値(pass)をログ・監査・API 応答に出さない。
export async function loadMailSendConfig(): Promise<MailSendConfig | null> {
  try {
    const row = await prisma.mailConfig.findUnique({ where: { id: MAIL_CONFIG_ID } });
    if (!row || !isMailConfigComplete(row)) return null;
    const pass = decryptSecret(row.smtpPassEnc as string);
    return {
      host: row.smtpHost as string,
      port: row.smtpPort as number,
      secure: row.smtpSecure,
      user: row.smtpUser as string,
      pass,
      from: row.fromAddress as string,
      appBaseUrl: row.appBaseUrl && row.appBaseUrl.trim() !== "" ? row.appBaseUrl : null,
      inquiryMailDetail: row.inquiryMailDetail === "full" ? "full" : "minimal",
    };
  } catch {
    return null;
  }
}
