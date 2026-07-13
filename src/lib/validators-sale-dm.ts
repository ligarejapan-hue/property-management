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
  filters: z.record(z.string(), z.string()).optional(), // 物件一覧と同じ検索条件(propertyIds 未指定時のフォールバック)
  // チェックで選んだ物件IDから作成する(指定時は filters より優先=対象=選択物件)。1回の生成は最大50物件
  // (= sale-dm-letter の MAX_GENERATE_ITEMS・同期生成の安全上限)。選んだ物件の宛先は共有者ぶんも含め全て生成する。
  propertyIds: z.array(z.string().uuid()).min(1).max(50, { message: "一度に選べる物件は50件までです" }).optional(),
  // 課金確認(最大50通の有料AI呼び出し+オーナーPII外部送信)。route が === true を要求する。
  confirmed: z.boolean().optional(),
  // 二重作成(再送信/別タブ/連打)防止の冪等性キー。client が作成試行ごとに安定生成し、成功で更新する。
  // route は生成の前にこのキーで campaign をクレームし、同キーの再実行は既存を返す(有料生成を二重に走らせない)。
  idempotencyKey: z.string().min(1).max(100).optional(),
});

export type SaleDmCampaignBody = z.infer<typeof saleDmCampaignBodySchema>;

// 型(DmVariant)= 設定一式。sender は型に持たせない(差出人はキャンペーン/env 既定)。
const variantOptionsSchema = saleDmOptionsSchema.omit({ senderName: true, senderContact: true });

// 型ごとの LP(印刷QR /t/<token> の遷移先)。郵送先で機能するには絶対 http(s) URL が必須。
// 空/相対/非http は弾く(resolveAbsoluteHttpEnv / isAbsoluteHttpUrl と同じ判定=保存時と redirect 時で一貫)。
export const saleDmLpUrlSchema = z
  .string()
  .trim()
  .max(2000)
  .refine(
    (u) => {
      try {
        const x = new URL(u);
        return x.protocol === "http:" || x.protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "LP は http(s) の絶対URLを指定してください" },
  );

export const saleDmVariantCreateSchema = z.object({
  label: z.string().min(1).max(40),
  options: variantOptionsSchema,
  // 型ごとLP(任意)。未指定の型は SALE_DM_LP_URL(既定)へ。
  lpUrl: saleDmLpUrlSchema.optional(),
});

// 更新は label・options・lpUrl をそれぞれ任意指定(部分更新)。lpUrl は null で「既定LPへ戻す(クリア)」。
export const saleDmVariantUpdateSchema = z.object({
  label: z.string().min(1).max(40).optional(),
  options: variantOptionsSchema.partial().optional(),
  lpUrl: saleDmLpUrlSchema.nullable().optional(),
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
