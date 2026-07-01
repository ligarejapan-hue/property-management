/** 販売図面テンプレの種別。propertyType から一意に決まる（サーバ/クライアント共通）。 */
export type SalesSheetTemplateKind = "land" | "mansion" | "house" | "building";

/**
 * 物件種別 → 販売図面テンプレ種別。対応するテンプレが無い種別（店舗/事務所等）は null。
 * new route（生成）と物件詳細画面（ボタン出し分け）の唯一の対応表。
 */
export function salesSheetTemplateKindFor(propertyType: string): SalesSheetTemplateKind | null {
  switch (propertyType) {
    case "land":
      return "land";
    case "apartment_unit":
      return "mansion";
    case "house":
      return "house";
    case "apartment_building":
    case "apartment_block":
      return "building";
    default:
      return null;
  }
}
