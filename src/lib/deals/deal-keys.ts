import { z } from "zod";

/**
 * 取引の鍵の記録(2026-11-26 発注者「鍵の番号・種類と本数を記録しておく箇所が必要」)。
 * 取引の `checklist_state.keys` に持つ(列は前からある・migration なし)。取引の物件タブの「鍵」で入れる。
 * 鍵受領書を出すときの初めの値になる。鍵の番号は変更履歴・監査には値を残さない(項目名だけ)。
 */
export const DEAL_KEYS_MAX = 30;

/** 1行=鍵の番号・種類と本数。番号・種類は空でもよい(番号が分からないことがある・2026-11-14 発注者)。 */
export const dealKeyRowSchema = z.object({ label: z.string().trim().max(50), count: z.number().int().min(1).max(99) }).strict();
export const dealKeysSchema = z.array(dealKeyRowSchema).max(DEAL_KEYS_MAX);
export type DealKeyRow = z.output<typeof dealKeyRowSchema>;

const objectOf = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** `checklist_state` の JSON → 鍵の行(無い・壊れていれば空)。 */
export function readDealKeys(checklistState: unknown): DealKeyRow[] {
  const r = dealKeysSchema.safeParse(objectOf(checklistState)?.keys);
  return r.success ? r.data : [];
}

/** `checklist_state` の keys の鍵だけを差し替える(ほかの鍵は残す)。 */
export function withDealKeys(checklistState: unknown, keys: DealKeyRow[]): Record<string, unknown> {
  return { ...(objectOf(checklistState) ?? {}), keys };
}
