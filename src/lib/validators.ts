import { z } from "zod";
import { PROPERTY_TYPE_VALUES, CASE_STATUS_VALUES, INTRODUCTION_ROUTE_VALUES } from "@/lib/property-types";
import {
  normalizeCorporateNumber,
  normalizeCompanyRegistryNumber,
} from "@/lib/corporate-number";
import { isValidPostalCode } from "@/lib/address-lookup/normalize";
import { normalizeRealEstateNumber } from "@/lib/address-normalizer";
import {
  FIELD_SURVEY_MEMO_MAX_LEN,
  FIELD_SURVEY_PIN_TYPES,
} from "@/lib/field-survey-constants";

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

// 会社法人等番号(12桁)入力フィールド共通スキーマ:
// - 空文字 / null / undefined → null（保存しない）
// - 12桁数字に正規化できる入力（全角・ハイフン・空白混じり許容）→ 正規化済 12桁
// - それ以外（13桁 / 11桁 / 数字以外混入）→ validation error
// 13桁法人番号(corporateNumberInputSchema)とは別物。互いに上書きしない。
const companyRegistryNumberInputSchema = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => {
    if (v == null) return null;
    const trimmed = v.trim();
    if (trimmed === "") return null;
    return v;
  })
  .superRefine((v, ctx) => {
    if (v === null) return;
    const normalized = normalizeCompanyRegistryNumber(v);
    if (normalized === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "会社法人等番号は12桁の数字で入力してください",
      });
    }
  })
  .transform((v) => (v === null ? null : normalizeCompanyRegistryNumber(v)));

// ---------- Property list query ----------

export const propertyListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  keyword: z.string().optional(),
  mgmtId: z.string().optional(),
  propertyType: z.enum(PROPERTY_TYPE_VALUES).optional(),
  // 複数種別まとめ絞り(カンマ区切り)。販売図面ピッカーが使用。空文字/空要素のみは未指定扱い。
  // 単一 propertyType と併用された場合は単一を優先する(後方互換・property-list-query 側で実装)。
  propertyTypes: z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      const items = v.split(",").map((s) => s.trim()).filter((s) => s !== "");
      return items.length === 0 ? undefined : items;
    })
    .pipe(z.array(z.enum(PROPERTY_TYPE_VALUES)).optional()),
  registryStatus: z.enum(["unconfirmed", "scheduled", "obtained"]).optional(),
  dmStatus: z.enum(["send", "hold", "no_send"]).optional(),
  // 宛先不明(返送連動)で絞り込む。"1" のときだけ有効(他の一覧フィルタと同じ文字列クエリ規約)。
  undeliverable: z.enum(["1"]).optional(),
  // DM送信回数フィルタ。現状は「未送信(0回)」のみ有効(空文字/未指定は絞らない)。
  // 「N回以下(1/2/3)」は列を持たず大規模データで groupBy+巨大 notIn になり重いため廃止し、
  // 送信回数の並べ替え(sortBy=dmSendCount)で代替する(@codex R10-P2 + ユーザー判断)。
  dmSentMax: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : v),
    z.coerce.number().int().min(0).max(0).optional(),
  ),
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
  sortBy: z.enum(["updatedAt", "createdAt", "address", "caseStatus", "dmSendCount"]).default("updatedAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

// ---------- Create property ----------

// 入力バリデーション(A2 UI総点検): 明らかな不正値の保存を防ぐ。空/未指定は許可(任意項目)。
// 既存データの編集を壊さないよう、値がある時だけ形式を検査する(郵便番号=7桁/不動産番号=数字/緯度経度=範囲)。
const optionalPostalCode = z
  .string()
  .optional()
  .nullable()
  // 全角数字/空白/各種ダッシュも許容(import・住所補完と同じ isValidPostalCode で判定)。生値でなく正規化後を検査(@codex R1)。
  .refine((v) => v == null || v === "" || isValidPostalCode(v), "郵便番号は7桁の数字で入力してください(例: 1000001 / 100-0001)");
const optionalRealEstateNumber = z
  .string()
  .optional()
  .nullable()
  // 数字(半/全角)+空白+区切りダッシュのみ許可し、正規化後が1〜13桁か。normalizeRealEstateNumber は非数字を削るため、
  // かな/英字/記号の混入("abc123"等)を許すと生値のまま保存され、数字番号として誤保存/誤突合される(@codex R1/R2)。
  .refine(
    (v) => v == null || v === "" || (/^[0-9０-９\s　\-‐-―ー－−]+$/.test(v) && /^\d{1,13}$/.test(normalizeRealEstateNumber(v))),
    "不動産番号は数字(最大13桁)で入力してください",
  );
const optionalLatitude = z.number().min(-90, "緯度は -90〜90 の範囲で入力してください").max(90, "緯度は -90〜90 の範囲で入力してください").optional().nullable();
const optionalLongitude = z.number().min(-180, "経度は -180〜180 の範囲で入力してください").max(180, "経度は -180〜180 の範囲で入力してください").optional().nullable();

export const createPropertySchema = z.object({
  propertyType: z.enum(PROPERTY_TYPE_VALUES),
  address: z.string().min(1, "住所は必須です"),
  postalCode: optionalPostalCode,
  lotNumber: z.string().optional().nullable(),
  buildingNumber: z.string().optional().nullable(),
  realEstateNumber: optionalRealEstateNumber,
  registryStatus: z.enum(["unconfirmed", "scheduled", "obtained"]).default("unconfirmed"),
  dmStatus: z.enum(["send", "hold", "no_send"]).default("hold"),
  caseStatus: z.enum(CASE_STATUS_VALUES).default("new_case"),
  introductionRoute: z.enum(INTRODUCTION_ROUTE_VALUES).optional().nullable(),
  gpsLat: optionalLatitude,
  gpsLng: optionalLongitude,
  note: z.string().optional().nullable(),
  assignedTo: z.string().uuid().optional().nullable(),
});

// ---------- Convert field-survey pin to property ----------

export const convertPinToPropertySchema = z.object({
  propertyType: z.enum(PROPERTY_TYPE_VALUES),
  address: z.string().min(1, "住所は必須です"),
  postalCode: optionalPostalCode,
  lotNumber: z.string().optional().nullable(),
  buildingNumber: z.string().optional().nullable(),
  realEstateNumber: optionalRealEstateNumber,
});
export type ConvertPinToPropertyInput = z.infer<typeof convertPinToPropertySchema>;

// ---------- Update property ----------

export const updatePropertySchema = z.object({
  propertyType: z.enum(PROPERTY_TYPE_VALUES).optional(),
  address: z.string().min(1).optional(),
  postalCode: optionalPostalCode,
  lotNumber: z.string().optional().nullable(),
  buildingNumber: z.string().optional().nullable(),
  realEstateNumber: optionalRealEstateNumber,
  registryStatus: z.enum(["unconfirmed", "scheduled", "obtained"]).optional(),
  dmStatus: z.enum(["send", "hold", "no_send"]).optional(),
  caseStatus: z.enum(CASE_STATUS_VALUES).optional(),
  introductionRoute: z.enum(INTRODUCTION_ROUTE_VALUES).optional().nullable(),
  gpsLat: optionalLatitude,
  gpsLng: optionalLongitude,
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
  companyRegistryNumber: companyRegistryNumberInputSchema.optional(),
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
  companyRegistryNumber: companyRegistryNumberInputSchema.optional(),
  version: z.number().int(),
});

// ---------- Link owner to property ----------

export const linkOwnerSchema = z.object({
  ownerId: z.string().uuid(),
  relationship: z.string().optional().nullable(),
  isPrimary: z.boolean().default(false),
});

// ---------- Create owner + link to property (atomic) ----------
// /api/properties/[id]/owners/create-and-link で使用。owner 作成フィールド（createOwnerSchema）に
// 紐付けの relationship / isPrimary を加える。フロントの createOwner→link 逐次実行を 1 リクエストへ
// 集約し、owner 作成と PropertyOwner link 作成を 1 つの DB transaction で atomic に行う（orphan 防止）。
export const createAndLinkOwnerSchema = createOwnerSchema.extend({
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
    // B-7: 「巡回を続ける」等の活動記録専用 (updatedAt を進めるだけ・他は不変)。
    // memo 送信で代用すると、一覧 API が memo を返さない設計のため null 上書きで
    // 既存 memo を消してしまう (@codex #308 R7)。
    touch: z.literal(true).optional(),
    // #317 (@codex R3): 終了/キャンセルのフェンストークン。client が直前の
    // 活動 touch 応答から得た session.updatedAt (= client 発行の世代値として
    // session に永続化済み) をそのまま echo する。server はこの等値を commit
    // 条件に使い、より古いトークンを運ぶ遅延リクエストを (どの段階で遅延
    // していても) 拒否できる。省略時は到着時刻条件へフォールバック。
    expectedUpdatedAt: z.string().datetime().optional(),
  })
  .refine(
    (v) => v.status !== undefined || v.memo !== undefined || v.touch === true,
    {
      message: "status / memo / touch のいずれかを指定してください",
    },
  );

export const fieldSurveySessionListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  staffUserId: z.string().uuid().optional(),
  status: z.enum(["active", "ended", "cancelled"]).optional(),
  // Phase 1-J: scope=all は read_all/manage のみ全スタッフ分を閲覧可。
  // mine (既定) は自分の session のみ。
  scope: z.enum(["mine", "all"]).default("mine"),
});

// ---------- Field survey track points (Phase 1-B) ----------

export const fieldSurveyTrackPointSchema = z.object({
  // sequence は session 内の連番 (再送 / dedup 用)。32bit int の余裕を残し
  // 2_000_000_000 で頭打ち。負数は許さない。
  sequence: z.number().int().min(0).max(2_000_000_000),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  // accuracy はメートル単位。実機 GPS の現実的範囲を超える 10km 以上は弾く。
  accuracy: z.number().min(0).max(10_000).optional().nullable(),
  recordedAt: z.string().datetime(),
});

export const fieldSurveyTrackPointBatchSchema = z
  .object({
    points: z.array(fieldSurveyTrackPointSchema).min(1).max(200),
  })
  .superRefine((v, ctx) => {
    // 同一 payload 内の sequence 重複はクライアントバグとして 422。
    // (retry / 再送による DB 重複は skipDuplicates で吸収する)
    const seen = new Set<number>();
    for (let i = 0; i < v.points.length; i++) {
      const s = v.points[i].sequence;
      if (seen.has(s)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `同一 payload 内で sequence=${s} が重複しています`,
          path: ["points", i, "sequence"],
        });
        return;
      }
      seen.add(s);
    }
  });

export const fieldSurveyTrackPointListQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  cursorSequence: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

// ---------- Field survey pin (Phase 1-C) ----------

const PIN_STATUSES = ["open", "closed", "archived"] as const;

// staffUserId は body から受け取らず session.id 固定にするため、schema からも
// 除外し .strict() で送信を拒否する。同様に lat/lng は PATCH で禁止する。
export const createFieldSurveyPinSchema = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracy: z.number().min(0).max(10_000).optional().nullable(),
    pinType: z.enum(FIELD_SURVEY_PIN_TYPES),
    memo: z.string().max(FIELD_SURVEY_MEMO_MAX_LEN).optional().nullable(),
    sessionId: z.string().uuid().optional().nullable(),
    propertyId: z.string().uuid().optional().nullable(),
  })
  .strict();

export const patchFieldSurveyPinSchema = z
  .object({
    pinType: z.enum(FIELD_SURVEY_PIN_TYPES).optional(),
    status: z.enum(PIN_STATUSES).optional(),
    memo: z.string().max(FIELD_SURVEY_MEMO_MAX_LEN).optional().nullable(),
    propertyId: z.string().uuid().nullable().optional(),
    sessionId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.pinType !== undefined ||
      v.status !== undefined ||
      v.memo !== undefined ||
      v.propertyId !== undefined ||
      v.sessionId !== undefined,
    { message: "更新フィールドを指定してください" },
  );

// 地図 pan/zoom で頻繁に叩かれるため、bbox は必須で面積上限を設ける。
// 0.5 度 ≒ 55km。緯度差・経度差ともに 0.5 度を上限とする (国内利用想定の市レベル+α)。
// pin / property map で共通利用するため、pin schema より先に export する。
export const FIELD_SURVEY_MAP_BBOX_MAX_DEG = 0.5;

export const fieldSurveyPinListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    status: z.enum(PIN_STATUSES).optional(),
    pinType: z.enum(FIELD_SURVEY_PIN_TYPES).optional(),
    sessionId: z.string().uuid().optional(),
    propertyId: z.string().uuid().optional(),
    staffUserId: z.string().uuid().optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    cursor: z.string().uuid().optional(),
    includeArchived: z
      .string()
      .default("false")
      .transform((v) => v === "true"),
    // optional bbox。Map UI が現在 viewport の pin だけ取得するため Phase 1-E
    // で追加。4 値同時指定が必須で、部分指定 / 反転 / 面積超過は 422。
    north: z.coerce.number().min(-90).max(90).optional(),
    south: z.coerce.number().min(-90).max(90).optional(),
    east: z.coerce.number().min(-180).max(180).optional(),
    west: z.coerce.number().min(-180).max(180).optional(),
    // map-safe projection。view=map のとき response から memo 本文を完全に除外し
    // hasMemo: boolean のみ返す (Codex Phase 1-E: Map UI の Network レスポンス
    // に memo 本文を載せない)。指定なしは既存 generic projection。
    view: z.enum(["map"]).optional(),
  })
  .superRefine((v, ctx) => {
    const present = [v.north, v.south, v.east, v.west].filter(
      (x) => x !== undefined,
    );
    if (present.length === 0) return;
    if (present.length !== 4) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "bbox は north / south / east / west 4 値同時指定が必要です",
        path: ["north"],
      });
      return;
    }
    const { north, south, east, west } = v as {
      north: number;
      south: number;
      east: number;
      west: number;
    };
    if (north < south) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "north は south 以上である必要があります",
        path: ["north"],
      });
      return;
    }
    if (east < west) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "east は west 以上である必要があります",
        path: ["east"],
      });
      return;
    }
    if (north - south > FIELD_SURVEY_MAP_BBOX_MAX_DEG) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `緯度差は ${FIELD_SURVEY_MAP_BBOX_MAX_DEG} 度以下にしてください`,
        path: ["north"],
      });
      return;
    }
    if (east - west > FIELD_SURVEY_MAP_BBOX_MAX_DEG) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `経度差は ${FIELD_SURVEY_MAP_BBOX_MAX_DEG} 度以下にしてください`,
        path: ["east"],
      });
      return;
    }
  });

// ---------- Field survey property map (Phase 1-D) ----------

export const fieldSurveyMapPropertyListQuerySchema = z
  .object({
    north: z.coerce.number().min(-90).max(90),
    south: z.coerce.number().min(-90).max(90),
    east: z.coerce.number().min(-180).max(180),
    west: z.coerce.number().min(-180).max(180),
    limit: z.coerce.number().int().min(1).max(500).default(200),
    cursor: z.string().uuid().optional(),
    includeArchived: z
      .string()
      .default("false")
      .transform((v) => v === "true"),
  })
  .superRefine((v, ctx) => {
    if (v.north < v.south) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "north は south 以上である必要があります",
        path: ["north"],
      });
      return;
    }
    // 日付変更線跨ぎは Phase 1-D では非対応
    if (v.east < v.west) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "east は west 以上である必要があります",
        path: ["east"],
      });
      return;
    }
    if (v.north - v.south > FIELD_SURVEY_MAP_BBOX_MAX_DEG) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `緯度差は ${FIELD_SURVEY_MAP_BBOX_MAX_DEG} 度以下にしてください`,
        path: ["north"],
      });
      return;
    }
    if (v.east - v.west > FIELD_SURVEY_MAP_BBOX_MAX_DEG) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `経度差は ${FIELD_SURVEY_MAP_BBOX_MAX_DEG} 度以下にしてください`,
        path: ["east"],
      });
      return;
    }
  });
