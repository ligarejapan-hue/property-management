/**
 * 型（variant）の凍結（設計 2026-08-08-sale-dm-external-paste-design.md §2.4）。
 *
 * 送付実績のある型の文面を後から差し替えると、同じ型の中に旧文面と新文面が混ざり、
 * **A/B比較が壊れ、送付済み文面の出所も失われる**。1件でも確定/送付済みができたら
 * その型の prompt_text / body_template は変更禁止にする（文面を変えたいときは新しい型）。
 *
 * ⚠判定は**二重**（@codex R13→R22）:
 *   ①列 `template_frozen_at` が立っている（永続の根拠。割当で確定 draft が型から
 *     離れても残る）
 *   ②配下に confirmed/sent の draft がある（即効の根拠。列がまだ立っていない窓＝
 *     照合スクリプト完了前を塞ぐ）
 * 互いの穴を補完するので、**どちらか一方だけにしない**。
 *
 * DB を触らない純関数のみ。クエリとロックは呼び出し側 route の責務。
 */

/** 確定/送付済みとみなす draft の状態（＝文面を凍結すべき証拠）。 */
export const SETTLED_DRAFT_STATUSES = ["confirmed", "sent"] as const;

export interface VariantFreezeState {
  /** 凍結印（null=未設定）。一度立てたら解除しない。 */
  templateFrozenAt: Date | null;
  /** 配下の confirmed/sent な draft 件数。 */
  settledCount: number;
}

export function isVariantFrozen(state: VariantFreezeState): boolean {
  return state.templateFrozenAt != null || state.settledCount > 0;
}

/**
 * 凍結印を立てる（未設定のときだけ・一度立てたら解除しない）。
 *
 * ⚠**確定を作る／別の型へ動かす／確定を戻す**、そのどれもが「凍結の証拠」を
 * 消し得るので、実行の**前に**呼ぶ（設計 §2.4 @codex R24→R31→R35）。
 * 呼び出し側は variant 行をロック済みであること。
 */
export async function markVariantsFrozen(
  tx: {
    dmVariant: {
      updateMany: (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => Promise<{ count: number }>;
    };
  },
  variantIds: string[],
  at: Date = new Date(),
): Promise<number> {
  const ids = [...new Set(variantIds)].sort();
  if (ids.length === 0) return 0;
  const r = await tx.dmVariant.updateMany({
    where: { id: { in: ids }, templateFrozenAt: null },
    data: { templateFrozenAt: at },
  });
  return r.count;
}
