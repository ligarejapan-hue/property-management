/**
 * 販売図面ピッカー（/sales-sheets/new）の純ロジック。
 * 一覧 API のクエリ組み立てと、API 行 → 表示行（種別ラベル・テンプレ種別）変換。
 * node 環境でユニットテスト可能なよう React 非依存に保つ。
 */
import { PROPERTY_TYPE_LABELS } from "@/lib/property-types";
import {
  salesSheetTemplateKindFor,
  type SalesSheetTemplateKind,
} from "./template-kind";

/** 図面を作れる種別（一覧 API の propertyTypes フィルタ用・既存データ互換で旧値 unit を含む）。 */
export const SALES_SHEET_CAPABLE_PROPERTY_TYPES = [
  "land",
  "apartment_unit",
  "unit",
  "house",
  "apartment_building",
  "apartment_block",
] as const;

/** 「新しい物件を登録して作成」で選ばせる種別（新規登録に旧値は使わない）。 */
export const SALES_SHEET_REGISTRABLE_PROPERTY_TYPES = [
  "land",
  "apartment_unit",
  "house",
  "apartment_building",
  "apartment_block",
] as const;

export interface PickerApiItem {
  id: string;
  propertyType: string;
  address: string;
  updatedAt: string;
}

export interface PickerRow {
  id: string;
  address: string;
  typeLabel: string;
  kind: SalesSheetTemplateKind | null;
  updatedAt: string;
}

/** ピッカーの一覧取得パラメタ（fetchProperties にそのまま渡す）。 */
export function buildPickerListParams(input: {
  keyword?: string;
  page?: number;
}): Record<string, string> {
  const params: Record<string, string> = {
    propertyTypes: SALES_SHEET_CAPABLE_PROPERTY_TYPES.join(","),
    page: String(input.page ?? 1),
    limit: "50",
    sortBy: "updatedAt",
    sortOrder: "desc",
  };
  const keyword = (input.keyword ?? "").trim();
  if (keyword) params.keyword = keyword;
  return params;
}

/** API 行 → 表示行。kind=null（対象外種別が万一混ざった場合）は呼び出し側でクリック不可にする。 */
export function buildPickerRows(items: PickerApiItem[]): PickerRow[] {
  return items.map((p) => ({
    id: p.id,
    address: p.address,
    typeLabel: PROPERTY_TYPE_LABELS[p.propertyType] ?? p.propertyType,
    kind: salesSheetTemplateKindFor(p.propertyType),
    updatedAt: p.updatedAt,
  }));
}
