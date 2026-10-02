import prisma from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { loadInquiryAutoReplySettings, loadMailSendConfig } from "@/lib/mail/mail-config";
import { sendPlainMail, safeErrorCode } from "@/lib/mail/transport";
import { loadSaleDmPublicPageConfig } from "./config-store";
import { buildInquiryAutoReplyMail } from "./inquiry-auto-reply-mail";

export type AutoReplyOutcome = "sent" | "failed" | "skipped";
// 同じアドレスへ続けて送らない間隔。フォームに他人のアドレスを書いて何度も申し込まれても、
// その人に届くのは1日1通までにする。
export const AUTO_REPLY_DEDUPE_WINDOW_MS = 24 * 3_600_000;

type Terminal =
  | { status: "sent" }
  | { status: "failed"; code: string }
  | { status: "skipped"; code: "disabled" | "duplicate" };

// ⚠監査に出すのは定型コードだけ(宛先アドレス・SMTP の応答は出さない)。
async function audit(inquiryId: string, result: Terminal): Promise<void> {
  await writeAuditLog({
    action: `inquiry_auto_reply_${result.status}`,
    targetTable: "dm_inquiries",
    targetId: inquiryId,
    detail: result.status === "sent" ? {} : { code: result.code },
  });
}

// 終端状態を書く。取り合いに勝った行(sending)だけを書き換え、監査を残す。
async function finish(inquiryId: string, result: Terminal): Promise<AutoReplyOutcome> {
  await prisma.dmInquiry.updateMany({
    where: { id: inquiryId, autoReplyStatus: "sending" },
    data: { autoReplyStatus: result.status },
  });
  await audit(inquiryId, result);
  return result.status;
}

// 取り合い。「同じアドレスへ直近に送った申込が無いこと」の確認と「自分が送る」の印付けを、
// アドレスごとの鍵の下で一続きに行う。鍵が無いと、同時に届いた同じアドレスの申込が
// 互いの印を見る前に確認を終えて、両方とも送ってしまう。
//  - claimed   : 自分が送る(none → sending)
//  - duplicate : 直近に送った(送っている最中の)申込がある(none → skipped)
//  - lost      : すでに誰かが処理した(何も書かない)
async function claimAutoReply(
  inquiryId: string,
  email: string,
  submittedAt: Date,
): Promise<"claimed" | "duplicate" | "lost"> {
  const lockKey = `inquiry-auto-reply:${email.toLowerCase()}`;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`;
    const duplicate = await tx.dmInquiry.findFirst({
      where: {
        id: { not: inquiryId },
        email: { equals: email, mode: "insensitive" },
        autoReplyStatus: { in: ["sending", "sent"] },
        submittedAt: { gte: new Date(submittedAt.getTime() - AUTO_REPLY_DEDUPE_WINDOW_MS) },
      },
      select: { id: true },
    });
    const claimed = await tx.dmInquiry.updateMany({
      where: { id: inquiryId, autoReplyStatus: "none", email: { not: null } },
      data: { autoReplyStatus: duplicate ? "skipped" : "sending" },
    });
    if (claimed.count === 0) return "lost";
    return duplicate ? "duplicate" : "claimed";
  });
}

// 申込者への受付メール。申込の記録が終わってから呼ぶ。送るのは1件につき1回だけで、
// 失敗しても送り直さない(宛先は申込者が書いた未確認のアドレス=繰り返し送らない)。
export async function sendInquiryAutoReply(inquiryId: string): Promise<AutoReplyOutcome> {
  // OFF のあいだは行に触らない(既定の状態で申込のたびに書き込みを増やさない)。
  if (!(await loadInquiryAutoReplySettings()).enabled) return "skipped";

  const row = await prisma.dmInquiry.findUnique({
    where: { id: inquiryId },
    select: { email: true, submittedAt: true, autoReplyStatus: true },
  });
  if (!row || !row.email || row.autoReplyStatus !== "none") return "skipped";

  const claim = await claimAutoReply(inquiryId, row.email, row.submittedAt);
  if (claim === "lost") return "skipped";
  if (claim === "duplicate") {
    await audit(inquiryId, { status: "skipped", code: "duplicate" });
    return "skipped";
  }

  // 送信が済んだ後の記録の失敗で「送れなかった」に書き換えない(書き換えると、同じアドレスへ
  // 続けて送らない確認から外れて、次の申込でもう1通送ってしまう)。
  let delivered = false;
  try {
    // スイッチと文面は送る直前に読み直す(取り合いの間に管理者が止めていたら送らない)。
    const settings = await loadInquiryAutoReplySettings();
    if (!settings.enabled) return await finish(inquiryId, { status: "skipped", code: "disabled" });
    const config = await loadMailSendConfig();
    if (!config) return await finish(inquiryId, { status: "failed", code: "mail_not_configured" });

    const sender = await loadSaleDmPublicPageConfig();
    const mail = buildInquiryAutoReplyMail(settings, sender);
    const res = await sendPlainMail(config, { to: row.email, subject: mail.subject, text: mail.text });
    if (!res.ok) {
      return await finish(inquiryId, { status: "failed", code: safeErrorCode({ code: res.code }) ?? "send_failed" });
    }
    delivered = true;
    return await finish(inquiryId, { status: "sent" });
  } catch (err) {
    if (!delivered) {
      // sending のまま残さない(記録できなくても送り直しはしないので、害は表示が出ないことだけ)。
      try {
        await finish(inquiryId, { status: "failed", code: "send_failed" });
      } catch {
        // 記録できなくても何もしない。
      }
    }
    throw err;
  }
}

// 受け口 route 用。待たない・throw しない。
export function startInquiryAutoReply(inquiryId: string): void {
  void sendInquiryAutoReply(inquiryId).catch((err: unknown) => {
    console.error("[sale_dm_inquiry_auto_reply] failed", {
      name: err instanceof Error ? err.name : "Unknown",
      code: safeErrorCode(err),
    });
  });
}
