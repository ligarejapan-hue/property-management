import { z } from "zod";
import { PROPERTY_TYPE_VALUES, CASE_STATUS_VALUES, INTRODUCTION_ROUTE_VALUES } from "@/lib/property-types";
import { normalizeCorporateNumber } from "@/lib/corporate-number";
import { FIELD_SURVEY_MEMO_MAX_LEN } from "@/lib/field-survey-constants";

// 法人番号入力フィールド共通スキーマ:
// - 空文字 / null / undefined → null（保存しない）
// - 13桁数字に正規化できる入力（全角・ハイフン・空白混じり許容）→ 正規化済 13桁
// - それ以外（12桁 / 14桁 / 数字以外混入）→ validation error
const corporateNumberInputSchema = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => {
    if (v == null) return null;
    const trimmed = v.trim();
    if (trimmed === "") return null;
    return v;
  })
  .superRefine((v, ctx) => {
    if (v === null) return;
    const normalized = normalizeCorporateNumber(v);
    if (normalized === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "法人番号は13桁の数字で入力してください",
      });
    }
  })
  .transform((v) => (v === null ? null : normalizeCorporateNumber(v)));

// ---------- Property list query ----------

export const propertyListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  keyword: z.string().optional(),
  mgmtId: z.string().optional(),
  propertyType: z.enum(PROPERTY_TYPE_VALUES).optional(),
  registryStatus: z.enum(["unconfirmed", "scheduled", "obtained"]).optional(),
  dmStatus: z.enum(["send", "hold", "no_send"]).optional(),
  caseStatus: z.enum(CASE_STATUS_VALUES).optional(),
  introductionRoute: z.enum(INTRODUCTION_ROUTE_VALUES).optional(),
  assignedTo: z.string().uuid().optional(),
  updatedFrom: z.string().optional(),
  updatedTo: z.string().optional(),
  includeArchived: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  // 警告 (quality-check の error / warning) があるものだけに絞り込む。
  // 互換: 未指定時は従来通り全件。"true" 文字列のときのみ true 扱い。
  hasWarning: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  sortBy: z.enum(["updatedAt", "createdAt", "address", "caseStatus"]).default("updatedAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

// ---------- Create property ----------

export const createPropertySchema = z.object({
  propertyType: z.enum(PROPERTY_TYPE_VALUES),
  address: z.string().min(1, "住所は必須です"),
  lotNumber: z.string().optional().nullable(),
  buildingNumber: z.string().optional().nullable(),
  realEstateNumber: z.string().optional().nullable(),
  registryStatus: z.enum(["unconfirmed", "scheduled", "obtained"]).default("unconfirmed"),
  dmStatus: z.enum(["send", "hold", "no_send"]).default("hold"),
  caseStatus: z.enum(CASE_STATUS_VALUES).default("new_case"),
  introductionRoute: z.enum(INTRODUCTION_ROUTE_VALUES).optional().nullable(),
  gpsLat: z.number().optional().nullable(),
  gpsLng: z.number().optional().nullable(),
  note: z.string().optional().nullable(),
  assignedTo: z.string().uuid().optional().nullable(),
});

// ---------- Update property ----------

export const updatePropertySchema = z.object({
  propertyType: z.enum(PROPERTY_TYPE_VALUES).optional(),
  address: z.string().min(1).optional(),
  lotNumber: z.string().optional().nullable(),
  buildingNumber: z.string().optional().nullable(),
  realEstateNumber: z.string().optional().nullable(),
  registryStatus: z.enum(["unconfirmed", "scheduled", "obtained"]).optional(),
  dmStatus: z.enum(["send", "hold", "no_send"]).optional(),
  caseStatus: z.enum(CASE_STATUS_VALUES).optional(),
  introductionRoute: z.enum(INTRODUCTION_ROUTE_VALUES).optional().nullable(),
  gpsLat: z.number().optional().nullable(),
  gpsLng: z.number().optional().nullable(),
  zoningDistrict: z.string().optional().nullable(),
  buildingCoverageRatio: z.number().optional().nullable(),
  floorAreaRatio: z.number().optional().nullable(),
  heightDistrict: z.string().optional().nullable(),
  firePreventionZone: z.string().optional().nullable(),
  scenicRestriction: z.string().optional().nullable(),
  roadType: z.string().optional().nullable(),
  roadWidth: z.number().optional().nullable(),
  frontageWidth: z.number().optional().nullable(),
  frontageDirection: z.string().optional().nullable(),
  setbackRequired: z.enum(["yes", "no", "unknown"]).optional().nullable(),
  rosenkaValue: z.number().int().optional().nullable(),
  rosenkaYear: z.number().int().optional().nullable(),
  rebuildPermission: z.enum(["yes", "no", "needs_review"]).optional().nullable(),
  architectureNote: z.string().optional().nullable(),
  note: z.string().optional().nullable(),
  assignedTo: z.string().uuid().optional().nullable(),
  version: z.number().int(), // optimistic locking
});

export type UpdatePropertyInput = z.infer<typeof updatePropertySchema>;

// ---------- Owner schemas ----------

export const createOwnerSchema = z.object({
  name: z.string().min(1, "氏名は必須です"),
  nameKana: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  zip: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  note: z.string().optional().nullable(),
  email: z.string().email("メールアドレスの形式が正しくありません").optional().nullable(),
  externalLinkKey: z.string().optional().nullable(),
  corporateNumber: corporateNumberInputSchema.optional(),
});

export const updateOwnerSchema = z.object({
  name: z.string().min(1).optional(),
  nameKana: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  zip: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  note: z.string().optional().nullable(),
  email: z.string().email("メールアドレスの形式が正しくありません").optional().nullable(),
  corporateNumber: corporateNumberInputSchema.optional(),
  version: z.number().int(),
});

// ---------- Link owner to property ----------

export const linkOwnerSchema = z.object({
  ownerId: z.string().uuid(),
  relationship: z.string().optional().nullable(),
  isPrimary: z.boolean().default(false),
});

// ---------- Field survey session ----------

export const createFieldSurveySessionSchema = z.object({
  // クライアント時計でなく server now を使うため受け取らない。
  // memo のみ受け付ける。
  memo: z.string().max(FIELD_SURVEY_MEMO_MAX_LEN).optional().nullable(),
});

export const patchFieldSurveySessionSchema = z
  .object({
    status: z.enum(["ended", "cancelled"]).optional(),
    memo: z.string().max(FIELD_SURVEY_MEMO_MAX_LEN).optional().nullable(),
  })
  .refine((v) => v.status !== undefined || v.memo !== undefined, {
    message: "status または memo のいずれかを指定してください",
  });

export const fieldSurveySessionListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  staffUserId: z.string().uuid().optional(),
  status: z.enum(["active", "ended", "cancelled"]).optional(),
});
