import {
  CASE_STATUS_LABELS, INTRODUCTION_ROUTE_LABELS, OCCUPANCY_STATUS_LABELS, PROPERTY_TYPE_LABELS,
} from "@/lib/property-types";

/** 取引の画面の横に出す物件の基本情報。GET /api/properties/[id] の項目のうち、ここで使うものだけ。 */
export type PropertySideSource = {
  caseStatus: string;
  contractPlannedOn?: string | null;
  settlementPlannedOn?: string | null;
  propertyType?: string | null;
  buildingName?: string | null;
  roomNo?: string | null;
  address?: string | null;
  lotNumber?: string | null;
  buildingNumber?: string | null;
  realEstateNumber?: string | null;
  salePrice?: number | null;
  exclusiveArea?: number | null;
  exclusiveAreaRegistry?: number | null;
  balconyArea?: number | null;
  landArea?: number | null;
  totalFloorArea?: number | null;
  layoutType?: string | null;
  floorNo?: number | null;
  structureType?: string | null;
  builtYear?: number | null;
  builtMonth?: number | null;
  access?: string | null;
  occupancyStatus?: string | null;
  managementFee?: number | null;
  repairReserveFee?: number | null;
  introductionRoute?: string | null;
  assignee?: { name: string } | null;
  note?: string | null;
};

const area = (v: number | null | undefined) => (v == null ? null : `${v}㎡`);
const yen = (v: number | null | undefined, suffix = "") => (v == null ? null : `${Number(v).toLocaleString("ja-JP")}円${suffix}`);
const label = (labels: Record<string, string>, v: string | null | undefined) => (v ? (labels[v] ?? v) : null);

function built(year: number | null | undefined, month: number | null | undefined): string | null {
  if (year == null) return null;
  return month == null ? `${year}年` : `${year}年${month}月`;
}

/** 表示する行。値が無い行は出さない(案件ステータスだけは必ず出す)。 */
export function propertySideRows(p: PropertySideSource): { label: string; value: string }[] {
  const rows: [string, string | null][] = [
    ["案件ステータス", label(CASE_STATUS_LABELS, p.caseStatus)],
    ["契約予定日", p.contractPlannedOn ?? null],
    ["決済予定日", p.settlementPlannedOn ?? null],
    ["種別", label(PROPERTY_TYPE_LABELS, p.propertyType)],
    ["物件名", p.buildingName || null],
    ["号室", p.roomNo || null],
    ["住居表示", p.address || null],
    ["所在・地番", p.lotNumber || null],
    ["家屋番号", p.buildingNumber || null],
    ["不動産番号", p.realEstateNumber || null],
    // salePrice は万円で保存している(物件の編集画面の「価格(万円)」)。
    ["価格", p.salePrice == null ? null : `${Number(p.salePrice).toLocaleString("ja-JP")}万円`],
    ["専有面積(壁芯)", area(p.exclusiveArea)],
    ["専有面積(登記簿)", area(p.exclusiveAreaRegistry)],
    ["バルコニー面積", area(p.balconyArea)],
    ["土地面積", area(p.landArea)],
    ["延床面積", area(p.totalFloorArea)],
    ["間取り", p.layoutType || null],
    ["所在階", p.floorNo == null ? null : `${p.floorNo}階`],
    ["構造", p.structureType || null],
    ["築年月", built(p.builtYear, p.builtMonth)],
    ["交通", p.access || null],
    ["現況", label(OCCUPANCY_STATUS_LABELS, p.occupancyStatus)],
    ["管理費", yen(p.managementFee, "/月")],
    ["修繕積立金", yen(p.repairReserveFee, "/月")],
    ["導入ルート", label(INTRODUCTION_ROUTE_LABELS, p.introductionRoute)],
    ["担当者", p.assignee?.name || null],
    ["備考", p.note || null],
  ];
  return rows.flatMap(([l, value]) => (value ? [{ label: l, value }] : []));
}
