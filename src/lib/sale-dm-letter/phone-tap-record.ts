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
 *  - 初回(phoneTapFirstAt == null)のみ phoneTapFirstAt = now をセット。
 *  - phoneTapCount は常に increment(+1)。
 *  - 検索失敗(findUnique)・更新失敗(DBエラー・ロック競合)いずれも best-effort。
 *    呼び出し元(公開 POST)の 204 応答を止めないよう、例外は投げず matched=false を返す。
 */

export interface PhoneTapDraftRow {
  id: string;
  propertyId: string;
  status: string;
  phoneTapFirstAt: Date | null;
}

/** $transaction のコールバックが受け取るクライアント。lockPropertyRow の TxLike と構造的に一致させる。 */
export interface PhoneTapTx {
  $queryRaw: <T>(query: TemplateStringsArray, ...values: unknown[]) => Promise<T>;
  dmRecipientDraft: {
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
        phoneTapFirstAt: true;
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
      select: { id: true, propertyId: true, status: true, phoneTapFirstAt: true },
    });
    if (!draft) return { matched: false, first: false };
    // 送付確定(sent)前のタップ(印刷プレビュー等)は計上しない。
    if (draft.status !== "sent") return { matched: false, first: false };

    const first = draft.phoneTapFirstAt == null;

    await client.$transaction(async (tx) => {
      await lockPropertyRow(tx, draft.propertyId);
      await tx.dmRecipientDraft.update({
        where: { id: draft.id },
        data: {
          phoneTapCount: { increment: 1 },
          // 初回のみセット(2回目以降は既存値を上書きしない)。
          ...(first ? { phoneTapFirstAt: new Date() } : {}),
        },
      });
    });
    return { matched: true, first, draftId: draft.id };
  } catch {
    // findUnique・$transaction いずれの失敗もここに落ちる。公開 POST の 204 応答を止めない。
    return { matched: false, first: false };
  }
}
