import type { Prisma } from "@/generated/prisma";

// findUnique/update だけに依存する最小インターフェース(prisma 本体 or $transaction tx を受ける)。
type TrackingTxLike = {
  dmRecipientDraft: {
    findUnique: (args: {
      where: { trackingToken: string };
      select: { id: true; lpFirstAccessAt: true };
    }) => Promise<{ id: string; lpFirstAccessAt: Date | null } | null>;
    update: (args: {
      where: { id: string };
      data: Prisma.DmRecipientDraftUpdateInput;
    }) => Promise<unknown>;
  };
};

/**
 * 追跡トークンのヒットを記録する。
 *  - 該当 draft が無ければ matched=false(更新しない)。
 *  - 初回(lpFirstAccessAt == null)のみ lpFirstAccessAt = now をセット。
 *  - lpAccessCount は常に increment(+1)。
 *
 * 公開 GET でこの DB 書込を行う妥当性:
 *  追跡リンクのアクセス記録は副作用が「当該1行の counter/timestamp 更新」に限定され、
 *  認証・課金・状態遷移を伴わない。これは「リンクが踏まれた」という観測の記録であり、
 *  GET の安全性(冪等的・観測のみ)を実質的に保つ。first-access は初回のみで冪等。
 *  bot/プリフェッチのノイズは将来 first-access 時刻で軽く判定する(初版は素朴に記録)。
 */
export async function recordTrackingHit(
  tx: TrackingTxLike,
  token: string,
): Promise<{ matched: boolean }> {
  const draft = await tx.dmRecipientDraft.findUnique({
    where: { trackingToken: token },
    select: { id: true, lpFirstAccessAt: true },
  });
  if (!draft) return { matched: false };

  await tx.dmRecipientDraft.update({
    where: { id: draft.id },
    data: {
      lpAccessCount: { increment: 1 },
      // 初回のみセット(2回目以降は undefined=既存値を上書きしない)。
      ...(draft.lpFirstAccessAt ? {} : { lpFirstAccessAt: new Date() }),
    },
  });
  return { matched: true };
}
