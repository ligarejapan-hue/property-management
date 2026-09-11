import type { Prisma } from "@/generated/prisma";
import { lockPropertyRow } from "@/lib/property-record-guard";

// ⚠この説明を関数直上へ移すと dm-writer-lock-order の走査(関数本文の文字列)に引っかかる
/**
 * 公開LPの電話ボタンのタップ計測(設計 §2.4)。
 *
 * recordTrackingHit(tracking-record.ts) と同じロック順序(親の物件行→draft 更新)を守るが、
 * これは「反響」ではないため outcome は触らず syncSaleDmReaction も呼ばない
 * (電話番号を見せた=タップした、は「連絡があった」の確証ではなく、A/B の反響指標を
 * 汚さないよう別カウンタ phoneTapCount/phoneTapFirstAt にだけ積む)。
 *  - 該当 draft が無ければ matched=false(更新しない)。
 *  - draft が未送付(status != sent)なら matched=false(送付前タップは計上しない)。
 *  - 「初回かどうか」はロックの外(pre-lock の findUnique)では判定しない(@codex P2:
 *    ほぼ同時に来た2つのタップが両方 phoneTapFirstAt===null を読んでしまい、両方
 *    first=true になり得るため)。ロック内で条件付き updateMany
 *    (where に phoneTapFirstAt: null を含める)を行い、実際に更新できた行数(count)
 *    で「自分がその場で null→date にできたか」を判定する(first = count === 1)。
 *  - phoneTapCount は常に increment(+1)(別の update で行う)。
 *  - 検索失敗(findUnique)・更新失敗(DBエラー・ロック競合)いずれも best-effort。
 *    呼び出し元(公開 POST)の 204 応答を止めないよう、例外は投げず matched=false を返す。
 */

export interface PhoneTapDraftRow {
  id: string;
  propertyId: string;
  status: string;
}

/** $transaction のコールバックが受け取るクライアント。lockPropertyRow の TxLike と構造的に一致させる。 */
export interface PhoneTapTx {
  $queryRaw: <T>(query: TemplateStringsArray, ...values: unknown[]) => Promise<T>;
  dmRecipientDraft: {
    // 「初回」の確定はこの条件付き updateMany の戻り値(count)で行う(ロック内)。
    updateMany: (args: {
      where: { id: string; phoneTapFirstAt: null };
      data: { phoneTapFirstAt: Date };
    }) => Promise<{ count: number }>;
    update: (args: {
      where: { id: string };
      data: Prisma.DmRecipientDraftUpdateInput;
    }) => Promise<unknown>;
  };
}

export interface PhoneTapClientLike {
  dmRecipientDraft: {
    findUnique: (args: {
      where: { trackingToken: string };
      select: {
        id: true;
        propertyId: true;
        status: true;
      };
    }) => Promise<PhoneTapDraftRow | null>;
  };
  $transaction: <T>(fn: (tx: PhoneTapTx) => Promise<T>) => Promise<T>;
}

export async function recordPhoneTap(
  client: PhoneTapClientLike,
  token: string,
): Promise<
  | { matched: false; first: false }
  | { matched: true; first: boolean; draftId: string }
> {
  try {
    const draft = await client.dmRecipientDraft.findUnique({
      where: { trackingToken: token },
      select: { id: true, propertyId: true, status: true },
    });
    if (!draft) return { matched: false, first: false };
    // 送付確定(sent)前のタップ(印刷プレビュー等)は計上しない。
    if (draft.status !== "sent") return { matched: false, first: false };

    let first = false;
    await client.$transaction(async (tx) => {
      await lockPropertyRow(tx, draft.propertyId);
      // ロックの中で「null→date にできたか」を条件付き updateMany の count で確定する
      // (pre-lock の読み取りで first を決めない=二重初回を防ぐ)。
      const claimed = await tx.dmRecipientDraft.updateMany({
        where: { id: draft.id, phoneTapFirstAt: null },
        data: { phoneTapFirstAt: new Date() },
      });
      first = claimed.count === 1;
      await tx.dmRecipientDraft.update({
        where: { id: draft.id },
        data: { phoneTapCount: { increment: 1 } },
      });
    });
    return { matched: true, first, draftId: draft.id };
  } catch {
    // findUnique・$transaction いずれの失敗もここに落ちる。公開 POST の 204 応答を止めない。
    return { matched: false, first: false };
  }
}
