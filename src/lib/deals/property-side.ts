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
  /** 所有者。⚠値はサーバーが表示レベルで伏せたもの。owner:read がなければ owner は id だけ。 */
  propertyOwners?: SideOwnerLink[];
  /** 棟につながる部屋の構造・築年月は棟の値が正(物件の編集画面と同じ)。 */
  building?: { structureType?: string | null; builtYear?: number | null; builtMonth?: number | null } | null;
};

export type SideOwnerLink = {
  id?: string;
  isPrimary?: boolean;
  relationship?: string | null;
  owner: {
    id?: string; name?: string | null; nameKana?: string | null; address?: string | null; currentAddress?: string | null;
    phone?: string | null; email?: string | null; note?: string | null;
  };
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
    ["構造", (p.building ? p.building.structureType : p.structureType) || null],
    ["築年月", p.building ? built(p.building.builtYear, p.building.builtMonth) : built(p.builtYear, p.builtMonth)],
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

export type OwnerSideView =
  | { kind: "forbidden" }
  | { kind: "none" }
  | { kind: "ok"; owners: { key: string; rows: { label: string; value: string }[] }[] };

/** 当事者タブの横に出す所有者情報。主な所有者が先。伏せられた値はそのまま・値が無い行は出さない。 */
export function ownerSideView(links: SideOwnerLink[] | undefined): OwnerSideView {
  const list = links ?? [];
  if (list.length === 0) return { kind: "none" };
  if (list.every((l) => !("name" in l.owner))) return { kind: "forbidden" };
  const ordered = [...list.filter((l) => l.isPrimary), ...list.filter((l) => !l.isPrimary)];
  return {
    kind: "ok",
    owners: ordered.map((l, i) => {
      const rows: [string, string | null | undefined][] = [
        ["氏名(法人名)", l.owner.name],
        ["フリガナ", l.owner.nameKana],
        ["主な所有者", l.isPrimary ? "はい" : null],
        ["続柄", l.relationship],
        ["登記上の住所", l.owner.address],
        ["現住所", l.owner.currentAddress],
        ["電話", l.owner.phone],
        ["メール", l.owner.email],
        ["備考", l.owner.note],
      ];
      return { key: l.id ?? String(i), rows: rows.flatMap(([label, value]) => (value ? [{ label, value }] : [])) };
    }),
  };
}
