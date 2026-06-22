import { z } from "zod";

export const saleDmOptionsSchema = z.object({
  designTemplate: z.enum(["formal", "soft", "impact"]),
  tone: z.enum(["formal", "standard", "soft"]),
  length: z.enum(["short", "medium", "long"]),
  appeal: z.enum(["price", "inheritance", "vacant", "buyer"]),
  strength: z.enum(["low", "medium", "high"]),
  senderName: z.string().min(1),
  senderContact: z.string().min(1),
  extraInstruction: z.string().optional(),
});

// 個別上書き(overrideJson)用: options の部分集合のみ許可する。
// designTemplate/tone/length/appeal/strength/extraInstruction を任意指定可能。
// senderName/senderContact は上書き対象外なので omit する(余剰キーは無視)。
export const saleDmOptionsOverrideSchema = saleDmOptionsSchema
  .omit({ senderName: true, senderContact: true })
  .partial();

export type SaleDmOptionsOverride = z.infer<typeof saleDmOptionsOverrideSchema>;

export const saleDmCampaignBodySchema = z.object({
  name: z.string().min(1),
  options: saleDmOptionsSchema,
  filters: z.record(z.string(), z.string()).optional(), // 物件一覧と同じ検索条件
});

export type SaleDmCampaignBody = z.infer<typeof saleDmCampaignBodySchema>;
