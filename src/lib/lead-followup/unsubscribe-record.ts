import prisma from "@/lib/prisma";

/**
 * 追客メールの配信停止を記録する(公開 `/u/f…` の POST から呼ぶ・設計 2026-11-16 §5)。
 *
 * 1. 追客の行からアドレスを引く(リンクにアドレスは載せない=行の id だけ)
 * 2. アドレス単位のロック(送る処理と同じ鍵 `lead-followup:<アドレス>`)の中で
 *    - 配信停止の表へ入れる(すでにあれば何もしない)
 *    - そのアドレスの進行中(active/sending)の追客を全部「停止(unsubscribed)」にする
 *
 * 返すのは種類だけ(画面はどれも同じ「受け付けました」=在否を答えない。監査に種類を残す)。
 */

export type FollowupUnsubscribeResult =
  | { kind: "recorded"; stopped: number }
  | { kind: "already"; stopped: number }
  | { kind: "missing" };

export function followupLockKey(emailNormalized: string): string {
  return `lead-followup:${emailNormalized}`;
}

export async function recordFollowupUnsubscribe(followupId: string): Promise<FollowupUnsubscribeResult> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.leadFollowup.findUnique({
      where: { id: followupId },
      select: { emailNormalized: true },
    });
    const email = row?.emailNormalized ?? null;
    if (!email) return { kind: "missing" } as const;

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${followupLockKey(email)})::bigint)`;

    const created = await tx.mailUnsubscribe.createMany({
      data: [{ emailNormalized: email, source: "link", followupId }],
      skipDuplicates: true,
    });
    const stopped = await tx.leadFollowup.updateMany({
      where: { emailNormalized: email, status: { in: ["active", "sending"] } },
      data: { status: "stopped", stopReason: "unsubscribed", stoppedAt: new Date(), claimedAt: null },
    });
    return created.count > 0
      ? ({ kind: "recorded", stopped: stopped.count } as const)
      : ({ kind: "already", stopped: stopped.count } as const);
  });
}
