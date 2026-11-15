import { formatYenText, manToYen } from "@/lib/yen-man";
import { businessTypeLabel } from "@/lib/property-business-type";
import { LEAD_EXCLUSION_STATUS_LABELS } from "@/lib/lead-exclusion";
import {
  DM_STATUS_LABELS, INTRODUCTION_ROUTE_LABELS, OCCUPANCY_STATUS_LABELS, PROPERTY_TYPE_LABELS, REGISTRY_STATUS_LABELS,
} from "@/lib/property-types";

/** 変更履歴に出す項目の画面の名前(変更履歴タブと経緯タブで共通)。 */
export const CHANGE_FIELD_LABELS: Record<string, string> = {
  realEstateNumber: "不動産番号",
  address: "住所",
  lotNumber: "地番",
  buildingNumber: "家屋番号",
  extraParcels: "ほかの土地・建物",
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
  // 英字の内部名のまま出ていた項目(2026-11-15)。言葉は物件の編集画面・棟の画面・経緯の所有者の項目と同じ(単位は付けない)。
  postalCode: "郵便番号",
  introductionRoute: "導入ルート",
  buildingCoverageRatio: "建蔽率",
  floorAreaRatio: "容積率",
  heightDistrict: "高度地区",
  firePreventionZone: "防火地域",
  // 景観の規制は編集画面に欄が無い(調査情報の取得だけが書く)。調査情報の項目の説明と同じ言葉にする。
  scenicRestriction: "景観規制",
  roadWidth: "道路幅員",
  frontageWidth: "間口幅",
  frontageDirection: "間口方角",
  rosenkaYear: "路線価年度",
  architectureNote: "建築備考",
  email: "メール",
  currentZip: "現住所の郵便番号",
  currentAddress: "現住所",
  corporateNumber: "法人番号",
  companyRegistryNumber: "会社法人等番号",
};

/** 棟の変更履歴だけ言葉が違う項目(棟の画面と同じ)。「name」は所有者では氏名・棟ではマンション名(2026-11-15)。 */
export const BUILDING_CHANGE_FIELD_LABELS: Record<string, string> = {
  name: "マンション名",
};

/** 表の持ち主の値だけを読む(toString などを拾わない)。 */
const own = (table: Record<string, string>, key: string): string | null =>
  Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;

/** 変更履歴の項目名(棟の行は棟の言葉を先に見る)。表に無い項目は内部名のまま返す。 */
export function changeFieldLabel(targetTable: string, fieldName: string): string {
  return (targetTable === "buildings" ? own(BUILDING_CHANGE_FIELD_LABELS, fieldName) : null) ?? own(CHANGE_FIELD_LABELS, fieldName) ?? fieldName;
}

/** 価格・うち消費税の履歴の値(万円で残る)を円で出す(「3,280万1,500円」・2026-11-03)。それ以外の欄は null。 */
export function saleYenHistoryValue(fieldName: string, value: string | null): string | null {
  if (fieldName !== "salePrice" && fieldName !== "saleTaxAmount") return null;
  if (value === null || value === "") return null;
  // 数字として読めない値(古い手入力など)はそのまま出す。
  if (!/^\d+(\.\d+)?$/.test(value)) return null;
  const yen = manToYen(value);
  return /^\d+$/.test(yen) ? formatYenText(yen) : null;
}

/** 物件の変更履歴の値を画面の書き方に(価格は円・取扱区分は「仲介」・登記状況は「取得済」など)。当てはまらない欄は null。 */
export function propertyHistoryValue(fieldName: string, value: string | null): string | null {
  if (fieldName === "businessType") return value ? businessTypeLabel(value) : null;
  // 登記状況は画面と同じ言葉で(謄本の添付で自動で取得済になる行が増えたため・2026-11-06)。
  if (fieldName === "registryStatus") return (value && Object.prototype.hasOwnProperty.call(REGISTRY_STATUS_LABELS, value) ? REGISTRY_STATUS_LABELS[value] : null);
  // DM判断も画面と同じ言葉で(「send → hold」と英字で出ていた・2026-11-08)。
  if (fieldName === "dmStatus") return (value && Object.prototype.hasOwnProperty.call(DM_STATUS_LABELS, value) ? DM_STATUS_LABELS[value] : null);
  // 現況・除外申請・種別・導入ルートも画面と同じ言葉で(「- → rented」「requested」と英字で出ていた・2026-11-15)。
  // 画面の表に無い値(古い取込の値など)は手を付けない=そのまま出す。
  if (Object.prototype.hasOwnProperty.call(CODE_VALUE_LABELS, fieldName)) return value ? own(CODE_VALUE_LABELS[fieldName], value) : null;
  return saleYenHistoryValue(fieldName, value);
}

/**
 * 値が内部の英字で残る項目と、その画面の名前の表(表は画面と同じものを使う=ここに写しを作らない)。
 * ⚠セットバック・再建築許可(yes / no など)は画面に名前の表が無いので、ここでは直さない。
 */
const CODE_VALUE_LABELS: Record<string, Record<string, string>> = {
  occupancyStatus: OCCUPANCY_STATUS_LABELS,
  leadExclusionStatus: LEAD_EXCLUSION_STATUS_LABELS,
  propertyType: PROPERTY_TYPE_LABELS,
  introductionRoute: INTRODUCTION_ROUTE_LABELS,
};

/** 値が true / false で残る項目(主所有者・保管・OC)。備考などの自由記述の「true」は直さない。 */
const BOOLEAN_CHANGE_FIELDS: ReadonlySet<string> = new Set(["isPrimary", "isArchived", "hasOc"]);

/** はい・いいえの欄の値(変更履歴タブ。経緯タブと同じ言葉・2026-11-15)。当てはまらなければ null。 */
export function historyBooleanLabel(fieldName: string, value: string | null): string | null {
  if (!BOOLEAN_CHANGE_FIELDS.has(fieldName)) return null;
  return value === "true" ? "はい" : value === "false" ? "いいえ" : null;
}

// ---------- ID で残る値(棟・担当者)を名前に直す ----------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DELETED_BUILDING_LABEL = "(削除・統合された棟)";
export const UNKNOWN_USER_LABEL = "(表示なし)";

/**
 * 名前を引く ID(物件の「棟」「担当者」の行の変更前後)。重複なし・ID の形の値だけ。
 * ⚠名前は履歴に書かず、見るときに引く(棟は後から名前が変わる・統合されるため・2026-11-15)。
 */
export function historyNameIds(
  rows: readonly { targetTable: string; fieldName: string; oldValue: string | null; newValue: string | null }[],
): { buildingIds: string[]; userIds: string[] } {
  const pick = (fieldName: string) => [
    ...new Set(
      rows
        .flatMap((r) => (r.targetTable === "properties" && r.fieldName === fieldName ? [r.oldValue, r.newValue] : []))
        .filter((v): v is string => !!v && UUID.test(v)),
    ),
  ];
  return { buildingIds: pick("buildingId"), userIds: pick("assignedTo") };
}

/** 「棟」の値(棟の ID)を今の名前で。見つからない棟は ID を出さず「(削除・統合された棟)」。空は null。 */
export function buildingHistoryLabel(value: string | null, names: ReadonlyMap<string, string>): string | null {
  if (value === null || value === "") return null;
  return names.get(value) ?? DELETED_BUILDING_LABEL;
}

/** 「担当者」の値(人の ID)を名前で。見つからなければ ID を出さず「(表示なし)」(経緯タブと同じ)。空は null。 */
export function userHistoryLabel(value: string | null, names: ReadonlyMap<string, string>): string | null {
  if (value === null || value === "") return null;
  return names.get(value) ?? UNKNOWN_USER_LABEL;
}
