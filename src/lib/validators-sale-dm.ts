import { z } from "zod";

export const saleDmOptionsSchema = z.object({
  designTemplate: z.enum(["formal", "soft", "impact"]),
  tone: z.enum(["formal", "standard", "soft"]),
  length: z.enum(["short", "medium", "long"]),
  appeal: z.enum(["price", "inheritance", "vacant", "buyer"]),
  strength: z.enum(["low", "medium", "high"]),
  // 差出人は env 既定(SALE_DM_SENDER_NAME/CONTACT)を route が補完するため任意。
  // 指定された場合のみ 1 文字以上を要求(空文字は不可)。
  // 各自由記述は最大長で上限する: これらは宛先ごとの prompt に展開され、1キャンペーンで最大50通の
  // 有料AI呼び出しに fan-out するため、巨大入力でのトークン浪費/タイムアウト/生成失敗を防ぐ(送信前に弾く)。
  senderName: z.string().min(1).max(100).optional(),
  senderContact: z.string().min(1).max(200).optional(),
  extraInstruction: z.string().max(1000).optional(),
});

// 個別上書き(overrideJson)用: options の部分集合のみ許可する。
// designTemplate/tone/length/appeal/strength/extraInstruction を任意指定可能。
// senderName/senderContact は上書き対象外なので omit する(余剰キーは無視)。
export const saleDmOptionsOverrideSchema = saleDmOptionsSchema
  .omit({ senderName: true, senderContact: true })
  .partial();

export type SaleDmOptionsOverride = z.infer<typeof saleDmOptionsOverrideSchema>;

export const saleDmCampaignBodySchema = z.object({
  name: z.string().min(1).max(100), // 他の自由記述(sender/label等)同様に上限。巨大DB書込/印刷title肥大を防ぐ。
  options: saleDmOptionsSchema,
  filters: z.record(z.string(), z.string()).optional(), // 物件一覧と同じ検索条件
  // 課金確認(最大50通の有料AI呼び出し+オーナーPII外部送信)。route が === true を要求する。
  confirmed: z.boolean().optional(),
});

export type SaleDmCampaignBody = z.infer<typeof saleDmCampaignBodySchema>;

// 型(DmVariant)= 設定一式。sender は型に持たせない(差出人はキャンペーン/env 既定)。
const variantOptionsSchema = saleDmOptionsSchema.omit({ senderName: true, senderContact: true });

export const saleDmVariantCreateSchema = z.object({
  label: z.string().min(1).max(40),
  options: variantOptionsSchema,
});

// 更新は label・options をそれぞれ任意指定(部分更新)。
export const saleDmVariantUpdateSchema = z.object({
  label: z.string().min(1).max(40).optional(),
  options: variantOptionsSchema.partial().optional(),
});

export type SaleDmVariantCreate = z.infer<typeof saleDmVariantCreateSchema>;
export type SaleDmVariantUpdate = z.infer<typeof saleDmVariantUpdateSchema>;

export const saleDmAssignSchema = z.object({
  mode: z.enum(["auto", "manual"]),
  order: z.enum(["sequential", "random"]).optional(),
  assignments: z
    .array(z.object({ recipientId: z.string(), variantId: z.string() }))
    .optional(),
});

export type SaleDmAssign = z.infer<typeof saleDmAssignSchema>;
