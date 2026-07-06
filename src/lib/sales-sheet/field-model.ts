/**
 * 販売図面の入力方式モデル(純・宣言的定義)。
 * widget/選択肢/単位/自動反映元/条件付き表示 を1か所で定義し、
 * 作成ダイアログと図面ビルダーが同じ定義を読む。
 * F1は売マンション(MANSION_FIELDS)のみ。他種別はF2で追加。
 */
import * as M from "./option-master";

export type FieldWidget = "select" | "multiselect" | "toggle" | "text" | "number";

export interface SheetField {
  key: string;
  label: string;
  widget: FieldWidget;
  section: string;
  options?: readonly string[];
  unit?: string;
  autoFrom?: string;      // 物件データ自動反映元
  controlOnly?: boolean;  // ダイアログのみ(表の行にしない)
  showWhen?: { field: string; equals: string };
}

export const MANSION_FIELDS: readonly SheetField[] = [
  // 価格・費用
  { key: "propertyType", label: "物件種目", widget: "select", section: "価格", options: M.PROPERTY_TYPE_MANSION, autoFrom: "propertyType" },
  { key: "buildingName", label: "建物名称", widget: "text", section: "価格", autoFrom: "buildingName" },
  { key: "price", label: "価格", widget: "number", section: "価格", unit: "万円" },
  { key: "unitPrice", label: "㎡単価", widget: "number", section: "価格", unit: "万円" },
  { key: "tax", label: "消費税", widget: "select", section: "価格", options: M.TAX, controlOnly: true },
  { key: "taxAmount", label: "うち消費税", widget: "number", section: "価格", unit: "万円", showWhen: { field: "tax", equals: "課税" } },
  { key: "managementFee", label: "管理費", widget: "number", section: "価格", unit: "円/月", autoFrom: "managementFee" },
  { key: "repairFee", label: "修繕積立金", widget: "number", section: "価格", unit: "円/月", autoFrom: "repairReserveFee" },
  // 所在・交通
  { key: "address", label: "所在地", widget: "text", section: "所在", autoFrom: "address" },
  { key: "access", label: "交通", widget: "text", section: "所在" },
  // 土地・権利
  { key: "siteArea", label: "敷地面積", widget: "number", section: "土地", unit: "㎡" },
  { key: "siteRightRatio", label: "敷地権割合共有持分", widget: "text", section: "土地" },
  { key: "landRight", label: "土地権利", widget: "select", section: "土地", options: M.LAND_RIGHT },
  { key: "useDistrict", label: "用途地域", widget: "multiselect", section: "土地", options: M.USE_DISTRICT, autoFrom: "zoningDistrict" },
  // 建物
  { key: "areaMethod", label: "面積計測方式", widget: "select", section: "建物", options: M.AREA_METHOD_MANSION, controlOnly: true },
  { key: "exclusiveArea", label: "専有面積", widget: "number", section: "建物", unit: "㎡", autoFrom: "exclusiveArea" },
  { key: "balconyArea", label: "バルコニー面積", widget: "number", section: "建物", unit: "㎡", autoFrom: "balconyArea" },
  { key: "balconyDir", label: "バルコニー向き", widget: "select", section: "建物", options: M.BALCONY_DIRECTION, autoFrom: "orientation" },
  { key: "layout", label: "間取り", widget: "text", section: "建物", autoFrom: "layoutType" },
  { key: "structure", label: "建物構造", widget: "select", section: "建物", options: M.BUILDING_STRUCTURE, autoFrom: "structureType" },
  { key: "floorNo", label: "所在階", widget: "number", section: "建物", unit: "階", autoFrom: "floorNo" },
  { key: "totalFloors", label: "地上階", widget: "number", section: "建物", unit: "階", autoFrom: "totalFloors" },
  { key: "basementFloors", label: "地下階", widget: "number", section: "建物", unit: "階" },
  { key: "builtYearMonth", label: "築年月", widget: "text", section: "建物", autoFrom: "builtYear" },
  { key: "totalUnits", label: "総戸数", widget: "number", section: "建物", unit: "戸", autoFrom: "totalUnits" },
  { key: "parking", label: "駐車場", widget: "select", section: "建物", options: M.PARKING_MANSION },
  { key: "parkingFee", label: "駐車場月額", widget: "number", section: "建物", unit: "円/月" },
  // 設備・現況・管理
  { key: "equipment", label: "設備・条件", widget: "text", section: "設備" },
  { key: "legalRestriction", label: "その他法令上の制限", widget: "text", section: "設備" },
  { key: "managementUnion", label: "管理組合", widget: "select", section: "設備", options: M.MANAGEMENT_UNION },
  { key: "managementForm", label: "管理形態", widget: "select", section: "設備", options: M.MANAGEMENT_FORM },
  { key: "managerStatus", label: "管理人状況", widget: "select", section: "設備", options: M.MANAGER_STATUS },
  { key: "managementCompany", label: "管理会社", widget: "text", section: "設備", autoFrom: "managementCompany" },
  { key: "developer", label: "分譲会社", widget: "text", section: "設備" },
  { key: "builder", label: "施工会社", widget: "text", section: "設備" },
  { key: "occupancy", label: "現況", widget: "select", section: "設備", options: M.OCCUPANCY, autoFrom: "occupancyStatus" },
  { key: "delivery", label: "引渡時期", widget: "select", section: "設備", options: M.DELIVERY_TIMING },
  { key: "remarks", label: "備考", widget: "text", section: "設備" },
];
