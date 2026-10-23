import { z } from "zod";
import { RATE_TABLE_KINDS, type RateTableKind } from "./rate-tables";

const bp = z.number().int().min(0).max(10000);
const yen = z.number().int().min(0).max(10_000_000_000_000);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** 区分は小さい順・最後の1つだけ上限なし(null)。 */
const ascendingLastNull = (rows: { upTo: number | null }[]) =>
  rows.every((r, i) => (i === rows.length - 1 ? r.upTo === null : r.upTo !== null && (i === 0 || r.upTo > (rows[i - 1].upTo as number))));

const bracketsSchema = z.object({
  brackets: z.array(z.object({ upTo: yen.nullable(), tax: yen }).strict()).min(1).max(30)
    .refine(ascendingLastNull, "金額の区分は小さい順にし、最後だけ上限なしにしてください"),
}).strict();

/** 税率の表の中身(種類ごと)。計算はこの形だけを信じる。 */
export const RATE_CONTENT_SCHEMAS = {
  consumption_tax: z.object({ rateBp: bp }).strict(),
  brokerage_tiers: z.object({
    tiers: z.array(z.object({ upTo: yen.nullable(), rateBp: bp }).strict()).min(1).max(5)
      .refine(ascendingLastNull, "価格の段は小さい順にし、最後だけ上限なしにしてください"),
    lowCostSpecial: z.object({ priceLimit: yen, feeCap: yen }).strict(),
  }).strict(),
  stamp_contract: bracketsSchema,
  stamp_receipt: bracketsSchema,
  capital_gains: z.object({
    long: z.object({ incomeTaxBp: bp, residentTaxBp: bp }).strict(),
    short: z.object({ incomeTaxBp: bp, residentTaxBp: bp }).strict(),
    reconstructionBp: bp,
    longTermYears: z.number().int().min(1).max(50),
    residentialDeduction: yen,
    unknownCostRateBp: bp,
  }).strict(),
} satisfies Record<RateTableKind, z.ZodType>;

export const rateTableInputSchema = z.object({
  kind: z.enum(RATE_TABLE_KINDS),
  validFrom: dateStr,
  validTo: dateStr.nullable(),
  content: z.unknown(),
}).strict()
  .refine((v) => v.validTo === null || v.validTo >= v.validFrom, "終わりの日は始まりの日以降にしてください")
  .refine((v) => RATE_CONTENT_SCHEMAS[v.kind].safeParse(v.content).success, "表の中身が正しくありません");

/** 期間が重なるか(終わりが null = 期限なし)。 */
export function periodsOverlap(
  a: { validFrom: string; validTo: string | null },
  b: { validFrom: string; validTo: string | null },
): boolean {
  const end = (v: string | null) => v ?? "9999-12-31";
  return a.validFrom <= end(b.validTo) && b.validFrom <= end(a.validTo);
}

/** 税率の表の追加・変更を種類ごとに1つずつにする鍵(pg_advisory_xact_lock 用)。 */
export const rateTableLockKey = (kind: string) => `deal_rate_tables:${kind}`;
