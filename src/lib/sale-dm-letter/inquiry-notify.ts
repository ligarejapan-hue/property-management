import prisma from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { isPlainOwnerLevel } from "@/lib/dm-export";
import { loadMailSendConfig, type MailSendConfig } from "@/lib/mail/mail-config";
import { sendPlainMail } from "@/lib/mail/transport";
import { checkSaleDmAccessFor } from "./route-guard";
import { buildInquiryNotifyMail, type InquiryNotifyFacts } from "./inquiry-notify-mail";
import { coarsePropertyLocation, propertyTypeLabel } from "./tags";

export const NOTIFY_RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;
export const NOTIFY_STALE_CLAIM_MS = 15 * 60_000;
export type NotifyOutcome = "sent" | "failed" | "skipped";

interface Recipient {
  userId: string;
  address: string;
  detail: "minimal" | "full";
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });

export async function countInquiryNotifyRecipients(): Promise<number> {
  return prisma.user.count({ where: { isActive: true, inquiryNotifyEnabled: true } });
}

async function loadFacts(inquiryId: string) {
  return prisma.dmInquiry.findUnique({
    where: { id: inquiryId },
    select: {
      id: true,
      submittedAt: true,
      name: true,
      phone: true,
      email: true,
      contactPref: true,
      contactTime: true,
      message: true,
      draft: {
        select: {
          campaign: { select: { name: true } },
          variant: { select: { label: true } },
          lpVariant: { select: { label: true } },
          property: { select: { address: true, propertyType: true, createdBy: true, assignedTo: true } },
        },
      },
    },
  });
}

// 通知先の絞り込み(設計 §2.6)。field_staff は自分が作成/担当の物件のみ・売却DMの表示権限が
// 平文でない利用者には送らない(通知メールに載せる情報を本人が画面でも見られない、はNG)。
// ⚠checkSaleDmAccessFor は権限/表示の拒否は ok:false で返すが、DB 例外は投げ得る。1人の失敗で
// 他の宛先まで巻き込まないよう、呼び出し側ごとに try/catch する。
async function resolveRecipients(
  property: { createdBy: string | null; assignedTo: string | null },
  config: MailSendConfig,
): Promise<Recipient[]> {
  const users = await prisma.user.findMany({
    where: { isActive: true, inquiryNotifyEnabled: true },
    select: { id: true, email: true, role: true, inquiryNotifyEmail: true },
    orderBy: { id: "asc" },
  });
  const out: Recipient[] = [];
  for (const u of users) {
    if (u.role === "field_staff" && property.createdBy !== u.id && property.assignedTo !== u.id) continue;
    let access;
    try {
      access = await checkSaleDmAccessFor(u.id);
    } catch {
      // この利用者の判定だけ諦めて次へ(1人のDB例外で通知全体を止めない)。
      continue;
    }
    if (!access.ok) continue;
    const bothPlain = isPlainOwnerLevel(access.ownerDisplayConfig.phone) && isPlainOwnerLevel(access.ownerDisplayConfig.email);
    const address = u.inquiryNotifyEmail && u.inquiryNotifyEmail.trim() !== "" ? u.inquiryNotifyEmail : u.email;
    out.push({ userId: u.id, address, detail: config.inquiryMailDetail === "full" && bothPlain ? "full" : "minimal" });
  }
  return out;
}

async function finish(
  inquiryId: string,
  attempts: number,
  result: { status: "sent" } | { status: "failed"; code: string },
  recipientUserIds: string[],
) {
  await prisma.dmInquiry.update({
    where: { id: inquiryId },
    data:
      result.status === "sent"
        ? { notifyStatus: "sent", notifyLastError: null, notifyAttempts: { increment: attempts } }
        : { notifyStatus: "failed", notifyLastError: result.code, notifyAttempts: { increment: attempts } },
  });
  await writeAuditLog(
    result.status === "sent"
      ? { action: "inquiry_notify_sent", targetTable: "dm_inquiries", targetId: inquiryId, detail: { attempt: attempts, recipientUserIds } }
      : { action: "inquiry_notify_failed", targetTable: "dm_inquiries", targetId: inquiryId, detail: { attempt: attempts, code: result.code } },
  );
}

// 通知の本体(設計 §2.6)。申込の記録が終わってから呼ぶ。1回目+再試行(30秒→2分→10分)。
// ⚠宛先アドレス・申込者の入力・SMTP の応答をログ/監査/notify_last_error に出さない。
// ⚠想定外の例外で行が "sending" のまま残らないよう、本体を try/catch で包み、終端状態
//   (failed / send_failed)を記録してから投げ直す(呼び出し元 startInquiryNotify は投げない)。
export async function notifyInquiry(inquiryId: string, opts: { now?: () => Date } = {}): Promise<NotifyOutcome> {
  const now = opts.now ?? (() => new Date());
  const claimedAt = now();
  const claim = await prisma.dmInquiry.updateMany({
    where: {
      id: inquiryId,
      OR: [
        { notifyStatus: { in: ["pending", "failed"] } },
        { notifyStatus: "sending", notifyClaimedAt: { lt: new Date(claimedAt.getTime() - NOTIFY_STALE_CLAIM_MS) } },
      ],
    },
    data: { notifyStatus: "sending", notifyClaimedAt: claimedAt },
  });
  if (claim.count === 0) return "skipped";

  try {
    const row = await loadFacts(inquiryId);
    if (!row) return "skipped";

    const config = await loadMailSendConfig();
    if (!config) {
      await finish(inquiryId, 1, { status: "failed", code: "mail_not_configured" }, []);
      return "failed";
    }
    const recipients = await resolveRecipients(row.draft.property, config);
    if (recipients.length === 0) {
      await finish(inquiryId, 1, { status: "failed", code: "no_recipients" }, []);
      return "failed";
    }

    const facts: InquiryNotifyFacts = {
      inquiryId: row.id,
      submittedAt: row.submittedAt,
      campaignName: row.draft.campaign.name,
      dmVariantLabel: row.draft.variant.label,
      lpVariantLabel: row.draft.lpVariant?.label ?? null,
      location: coarsePropertyLocation(row.draft.property.address),
      propertyTypeLabel: propertyTypeLabel(row.draft.property.propertyType),
      name: row.name,
      phone: row.phone,
      email: row.email,
      contactPref: row.contactPref,
      contactTime: row.contactTime,
      message: row.message,
    };

    const succeeded = new Set<string>();
    let attempts = 0;
    for (let i = 0; i <= NOTIFY_RETRY_DELAYS_MS.length; i += 1) {
      if (i > 0) {
        await sleep(NOTIFY_RETRY_DELAYS_MS[i - 1]);
        await prisma.dmInquiry.updateMany({ where: { id: inquiryId, notifyStatus: "sending" }, data: { notifyClaimedAt: now() } });
      }
      attempts += 1;
      for (const r of recipients) {
        if (succeeded.has(r.userId)) continue;
        const mail = buildInquiryNotifyMail(facts, { detail: r.detail, appBaseUrl: config.appBaseUrl });
        const res = await sendPlainMail(config, { to: r.address, subject: mail.subject, text: mail.text });
        if (res.ok) succeeded.add(r.userId);
      }
      if (succeeded.size === recipients.length) {
        await finish(inquiryId, attempts, { status: "sent" }, recipients.map((r) => r.userId));
        return "sent";
      }
    }
    await finish(inquiryId, attempts, { status: "failed", code: succeeded.size > 0 ? "partial" : "send_failed" }, []);
    return "failed";
  } catch (err) {
    // ここに来るのは resolveRecipients/loadFacts/sendPlainMail 等が想定外に投げた場合(すべて
    // throw しない設計だが、DB 接続断など予期しない失敗まで飲み込まない)。"sending" のまま
    // 行を残さないよう、失敗の記録だけ試みてから投げ直す(記録自体が失敗しても再送は残る)。
    try {
      await finish(inquiryId, 1, { status: "failed", code: "send_failed" }, []);
    } catch {
      // 記録できなくても、行は 15 分後に notifyClaimedAt の期限切れで取り直せる。
    }
    throw err;
  }
}

// 受け口 route 用。待たない・throw しない。
export function startInquiryNotify(inquiryId: string): void {
  void notifyInquiry(inquiryId).catch((err: unknown) => {
    console.error("[sale_dm_inquiry_notify] failed", {
      name: err instanceof Error ? err.name : "Unknown",
      code: typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : null,
    });
  });
}
