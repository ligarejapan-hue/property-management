import { formatYenText, manToYen } from "@/lib/yen-man";
import { businessTypeLabel } from "@/lib/property-business-type";

/** 変更履歴に出す項目の画面の名前(変更履歴タブと経緯タブで共通)。 */
export const CHANGE_FIELD_LABELS: Record<string, string> = {
  realEstateNumber: "不動産番号",
  address: "住所",
  lotNumber: "地番",
  buildingNumber: "家屋番号",
  buildingName: "物件名",
  buildingId: "棟",
  registryStatus: "登記状況",
  dmStatus: "DM判断",
  caseStatus: "案件ステータス",
  // 案件ステータス 8〜10 の日付の欄(値は YYYY-MM-DD で残る)。
  contractPlannedOn: "契約予定日",
  settlementPlannedOn: "決済予定日",
  // 問い合わせ者(値は所有者の氏名と同じ扱いで API が伏せて返す)・除外申請(2026-10-24)。
  inquirerName: "問い合わせ者",
  leadExclusionStatus: "除外申請",
  leadExclusionRequestedAt: "除外申請日",
  leadExclusionDecidedAt: "除外申請の結果の日",
  propertyType: "種別",
  businessType: "取扱区分",
  assignedTo: "担当者",
  zoningDistrict: "用途地域",
  rosenkaValue: "路線価",
  rebuildPermission: "再建築許可",
  roadType: "道路種別",
  setbackRequired: "セットバック",
  name: "氏名",
  nameKana: "氏名カナ",
  phone: "電話番号",
  zip: "郵便番号",
  note: "備考",
  propertyId: "物件ID",
  ownerId: "所有者ID",
  relationship: "関係",
  isPrimary: "主所有者",
  gpsLat: "緯度",
  gpsLng: "経度",
  totalFloors: "階数",
  totalUnits: "総戸数",
  builtYear: "築年",
  structureType: "構造",
  managementCompany: "管理会社",
  dmScenarioId: "DMの種類",
  // 販売図面から物件・棟へ保存する列(apply-writeback が変更履歴を直接書く)。
  salePrice: "価格",
  saleTaxType: "消費税",
  saleTaxAmount: "うち消費税",
  access: "交通",
  landArea: "土地面積",
  landAreaMethod: "面積計測方式",
  totalFloorArea: "建物面積・延床面積",
  builtMonth: "築月",
  aboveFloors: "地上階",
  basementFloors: "地下階",
  parking: "駐車場",
  grossYield: "想定利回り",
  expectedIncome: "満室想定収入",
  // 区分マンション(販売図面・CSV の「既存物件の更新」)。
  floorNo: "所在階",
  exclusiveArea: "専有面積（壁芯）",
  exclusiveAreaRegistry: "専有面積（登記簿）",
  balconyArea: "バルコニー面積",
  layoutType: "間取り",
  orientation: "バルコニー向き",
  managementFee: "管理費",
  repairReserveFee: "修繕積立金",
  ownershipShareNote: "持分メモ",
  roomNo: "部屋番号",
  occupancyStatus: "現況",
};

/** 価格・うち消費税の履歴の値(万円で残る)を円で出す(「3,280万1,500円」・2026-11-03)。それ以外の欄は null。 */
export function saleYenHistoryValue(fieldName: string, value: string | null): string | null {
  if (fieldName !== "salePrice" && fieldName !== "saleTaxAmount") return null;
  if (value === null || value === "") return null;
  // 数字として読めない値(古い手入力など)はそのまま出す。
  if (!/^\d+(\.\d+)?$/.test(value)) return null;
  const yen = manToYen(value);
  return /^\d+$/.test(yen) ? formatYenText(yen) : null;
}

/** 物件の変更履歴の値を画面の書き方に(価格は円・取扱区分は「仲介」など)。当てはまらない欄は null。 */
export function propertyHistoryValue(fieldName: string, value: string | null): string | null {
  if (fieldName === "businessType") return value ? businessTypeLabel(value) : null;
  return saleYenHistoryValue(fieldName, value);
}
