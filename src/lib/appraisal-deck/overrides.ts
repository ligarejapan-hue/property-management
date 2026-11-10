/**
 * 担当者が下書きで直せる項目(appraisal_decks.overrides)。読み取った数字(extracted)に上書きする。
 * ⚠所在地は町丁目までしか受け取らない(番地・建物名を入れられないよう trimToChome を通す)。
 * ⚠自由に書ける文章は見出しだけ(長さを絞る)。依頼者の氏名などは入れない運用(画面で注意を出す)。
 */
import { z } from "zod";
import { trimToChome, type AppraisalExtract } from "./parse";

const MAN = z.number().finite().min(0).max(9_999_999); // 万円
const TSUBO = z.number().finite().min(0).max(999_999); // 万円/坪
const PCT = z.number().finite().min(-100).max(100);
const SHORT = z.string().trim().max(60);

const valueSchema = z
  .object({
    total: MAN.nullable(),
    tsubo: TSUBO.nullable(),
    land: MAN.nullable(),
    landTsubo: TSUBO.nullable(),
    building: MAN.nullable(),
    buildingTsubo: TSUBO.nullable(),
  })
  .partial()
  .strict();

const planSchema = z
  .object({ name: z.enum(["speed", "standard", "challenge"]), price: MAN, tsubo: TSUBO.nullable() })
  .strict();

const rangeSchema = z
  .object({ min: MAN, max: MAN, minTsubo: TSUBO.nullable(), maxTsubo: TSUBO.nullable() })
  .strict()
  .refine((r) => r.min <= r.max, { message: "価格の幅は下限が上限以下になるようにしてください" });

export const HEADLINE_KEYS = ["result", "basis", "plans", "fund"] as const;

export const appraisalOverridesSchema = z
  .object({
    area: SHORT.nullable(),
    station: SHORT.nullable(),
    walkMinutes: z.number().int().min(0).max(999).nullable(),
    landSqm: z.number().finite().min(0).max(9_999_999).nullable(),
    landTsubo: z.number().finite().min(0).max(9_999_999).nullable(),
    expected: valueSchema,
    ai: valueSchema,
    adjustment: z
      .object({ landPercent: PCT.nullable(), landAmount: z.number().finite().min(-9_999_999).max(9_999_999).nullable(), liquidityPercent: PCT.nullable() })
      .partial()
      .strict(),
    plans: z
      .array(planSchema)
      .max(3)
      .refine((ps) => new Set(ps.map((p) => p.name)).size === ps.length, { message: "同じ案が2つあります" }),
    range: rangeSchema.nullable(),
    headlines: z.object(Object.fromEntries(HEADLINE_KEYS.map((k) => [k, z.string().trim().max(120)]))).partial().strict(),
  })
  .partial()
  .strict()
  .transform((o) => (o.area != null ? { ...o, area: trimToChome(o.area) } : o));

export type AppraisalOverrides = z.infer<typeof appraisalOverridesSchema>;

/** 読み取った数字に担当者の修正を重ねた、資料に使う値。 */
export function mergeAppraisal(extracted: AppraisalExtract, overrides: AppraisalOverrides) {
  const { headlines, expected, ai, adjustment, ...rest } = overrides;
  return {
    ...extracted,
    ...rest,
    expected: { ...extracted.expected, ...expected },
    ai: { ...extracted.ai, ...ai },
    adjustment: { ...extracted.adjustment, ...adjustment },
    headlines: headlines ?? {},
  };
}
