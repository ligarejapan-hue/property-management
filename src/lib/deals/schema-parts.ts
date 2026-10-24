import { z } from "zod";

/** 文字の欄: 前後の空白を落とし、空なら null。 */
export const text = (max: number) =>
  z.string().trim().max(max).nullable().transform((v) => (v === null || v === "" ? null : v));
export const yenInt = z.number().int().min(0).max(1_000_000_000_000);
/** 実在する日付の YYYY-MM-DD(2015-02-30 などは通さない)。 */
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}, "日付が正しくありません");
/** 費用のその他の行(名前と金額)。 */
export const otherCostSchema = z.object({ label: z.string().trim().min(1).max(50), amount: yenInt }).strict();
