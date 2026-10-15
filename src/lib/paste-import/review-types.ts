/**
 * 「貼り付けて物件化」確認画面の型。API 契約（POST /api/import/paste のレスポンスの一部）と、
 * 画面で人が直す値の形。⚠部品(paste-import-review.tsx)から re-export している。
 * src/lib 側(作業中の控えの検査)からも使うので、部品ではなくここに置く。
 */
import type { PasteDraft } from "./types";

export interface PasteDuplicatesResult {
  blocked: boolean;
  blockedByPropertyId: string | null;
  similarPropertyIds: string[];
}

export interface SimilarPropertySummary {
  id: string;
  address: string | null;
  lotNumber: string | null;
}

export type OwnerMatchKind = "current_address" | "registry_address" | "name_only";

export interface OwnerCandidateSummary {
  id: string;
  name: string;
  matchKind: OwnerMatchKind;
  /** 表示レベルを通した住所（**実際に一致した方**。name_only なら参考として1つ）。 */
  address: string | null;
  /** 上の住所がどちらの欄のものか（札と食い違わせないために必ず添える）。 */
  addressKind: "current" | "registry" | null;
  /** その所有者に紐づく物件の件数（非個人情報の識別の手がかり）。 */
  propertyCount: number;
}

export type OwnerMode = "link" | "new" | "none";

export type PropertyFieldKey = keyof PasteDraft["property"];
export type PropertyValues = Record<PropertyFieldKey, string>;

export type OwnerFieldKey = "name" | "nameKana" | "phone" | "email" | "currentAddress";
export type OwnerValues = Record<OwnerFieldKey, string>;
