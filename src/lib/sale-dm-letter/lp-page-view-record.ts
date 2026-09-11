import type { Prisma } from "@/generated/prisma";
import { lockPropertyRow } from "@/lib/property-record-guard";

// ⚠この説明を関数直上へ移すと dm-writer-lock-order の走査(関数本体の文字列)に引っかかる
/**
 * 公開LPの「アプリ内ご案内ページを実際に返せた」閲覧の計測(@codex R10)。
 *
 * recordTrackingHit(tracking-record.ts) が立てる lpFirstAccessAt は「QR を読まれた」だけで、
 * その先が外部LPへの転送だった場合(公開スイッチ未投入・LP型に文章なし・読み出し失敗)も
 * 立つ。LP型ごとの成績に外部LPへの訪問を混ぜないため、実際に HTML を返したときだけこちらを積む。
 *
 * ロック順序は phone-tap-record.ts と同じ(親の物件行→draft 更新)。これは「反響」ではないので
 * syncSaleDmReaction は呼ばず outcome も触らない(閲覧の反響化は従来どおり recordTrackingHit の役割)。
 *  - 「初回かどうか」はロックの外で判定しない。ロック内の条件付き updateMany
 *    (where に lpPageFirstAt: null を含める)の count で確定する(同時アクセスで二重初回にならない)。
 *  - lpPageViewCount は常に increment(+1)。
 *  - 更新失敗(DBエラー・ロック競合)は best-effort。受け手へのページ表示を止めないよう例外は投げず
 *    { first: false } を返す。
 */

/** $transaction のコールバックが受け取るクライアント。lockPropertyRow の TxLike と構造的に一致させる。 */
export interface LpPageViewTx {
  $queryRaw: <T>(query: TemplateStringsArray, ...values: unknown[]) => Promise<T>;
  dmRecipientDraft: {
    // 「初回」の確定はこの条件付き updateMany の戻り値(count)で行う(ロック内)。
    updateMany: (args: {
      where: { id: string; lpPageFirstAt: null };
      data: { lpPageFirstAt: Date };
    }) => Promise<{ count: number }>;
    update: (args: {
      where: { id: string };
      data: Prisma.DmRecipientDraftUpdateInput;
    }) => Promise<unknown>;
  };
}

export interface LpPageViewClientLike {
  $transaction: <T>(fn: (tx: LpPageViewTx) => Promise<T>) => Promise<T>;
}

export async function recordLpPageView(
  client: LpPageViewClientLike,
  draft: { draftId: string; propertyId: string },
): Promise<{ first: boolean }> {
  try {
    let first = false;
    await client.$transaction(async (tx) => {
      await lockPropertyRow(tx, draft.propertyId);
      const claimed = await tx.dmRecipientDraft.updateMany({
        where: { id: draft.draftId, lpPageFirstAt: null },
        data: { lpPageFirstAt: new Date() },
      });
      first = claimed.count === 1;
      await tx.dmRecipientDraft.update({
        where: { id: draft.draftId },
        data: { lpPageViewCount: { increment: 1 } },
      });
    });
    return { first };
  } catch {
    // 計測は best-effort。公開ページの 200 応答を止めない。
    return { first: false };
  }
}
