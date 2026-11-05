import { toHalfWidthDigits } from "@/lib/registry-fetch/chiban-input";
import { joinedParcelNumbers, parcelNumberLabel, type ParcelKind } from "@/lib/property-parcels";

/** 写しの地番・家屋番号。並べると欄の長さを超えるときは「1番1 ほか◯筆」(読めない値にして消さない)。 */
const parcelNumbersFor = (main: string | null, extra: unknown, kind: ParcelKind, max: number): string | null => {
  const joined = joinedParcelNumbers(main, extra, kind);
  return joined && joined.length > max ? parcelNumberLabel(main, extra, kind) : joined;
};
import { PROPERTY_TYPE_LABELS } from "@/lib/property-types";
import {
  EMPTY_BROKER, EMPTY_SNAPSHOT, counterpartyBrokerSchema, propertySnapshotSchema,
  type CounterpartyBroker, type PropertySnapshot,
} from "./schemas";

/** 写しに使う物件の列(+現地担当の範囲判定に使う createdBy/assignedTo)。 */
export const SNAPSHOT_PROPERTY_SELECT = {
  propertyType: true, address: true, lotNumber: true, buildingNumber: true, extraParcels: true, buildingName: true, roomNo: true,
  exclusiveArea: true, totalFloorArea: true, landArea: true, structureType: true, builtYear: true, builtMonth: true,
  access: true, layoutType: true, createdBy: true, assignedTo: true, managementFee: true, repairReserveFee: true,
} as const;

/**
 * 物件 → 精算の管理費・修繕積立金(2026-11-02 発注者「物件の情報から取得」)。
 * ⚠区分だけ(精算の画面に欄があるのも区分だけ。ほかの種別に入れると事業計画書の月額に混ざる)。
 * ⚠物件が空の項目は返さない=取引で手入れした額を空で消さない。
 */
export function settlementFeesFromProperty(p: {
  propertyType: string; managementFee: number | null; repairReserveFee: number | null;
}): { managementFee?: number; repairReserve?: number } {
  if (p.propertyType !== "apartment_unit" && p.propertyType !== "unit") return {};
  return {
    ...(p.managementFee != null ? { managementFee: p.managementFee } : {}),
    ...(p.repairReserveFee != null ? { repairReserve: p.repairReserveFee } : {}),
  };
}

type Num = { toString(): string } | number | string | null;
interface SnapshotSource {
  propertyType: string; address: string; lotNumber: string | null; buildingNumber: string | null;
  /** 2筆目以降の土地・2棟目以降の建物。写しの地番・家屋番号に「、」でつないで入れる(書類にそのまま出る・2026-11-05)。 */
  extraParcels?: unknown;
  buildingName: string | null; roomNo: string | null; exclusiveArea: Num; totalFloorArea: Num; landArea: Num;
  structureType: string | null; builtYear: number | null; builtMonth: number | null; access: string | null; layoutType: string | null;
}

const num = (v: Num): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(String(v));
  return Number.isFinite(n) ? n : null;
};
const str = (v: string | null) => (v && v.trim() ? v.trim() : null);
/** 住所・番号の数字は半角で写す(発注者「数字を半角で統一」)。 */
const strHalf = (v: string | null) => { const s = str(v); return s && toHalfWidthDigits(s); };

/** 物件 → 写し。住居表示の専用欄は無いので住所を当てる(設計 §1)。土地の権利は物件に無い=空。 */
export function buildSnapshotFromProperty(p: SnapshotSource): PropertySnapshot {
  const isUnit = p.propertyType === "apartment_unit" || p.propertyType === "unit";
  // 写しの範囲を外れた値(和暦の年・長すぎる交通 など)は、ここで空にする。保存したあとに
  // readSnapshot で読めず、画面で空に見えて次の保存で消える、を防ぐ(保存したものは必ず読める)。
  return readSnapshot({
    buildingName: strHalf(p.buildingName), roomNo: strHalf(p.roomNo), address: strHalf(p.address), lotNumber: strHalf(parcelNumbersFor(p.lotNumber, p.extraParcels, "land", 300)),
    buildingNumber: strHalf(parcelNumbersFor(p.buildingNumber, p.extraParcels, "building", 100)), propertyTypeLabel: PROPERTY_TYPE_LABELS[p.propertyType] ?? null,
    structure: str(p.structureType), builtYear: p.builtYear, builtMonth: p.builtMonth,
    floorArea: num(isUnit ? p.exclusiveArea : p.totalFloorArea), landArea: num(p.landArea), landRight: null,
    access: str(p.access), layout: str(p.layoutType),
  });
}

type Parser = { safeParse(v: unknown): { success: boolean; data?: unknown } };

/** 保存済みの JSON を読む。欠け・壊れた項目は1つずつ空で補う(1つの不正で全体を捨てない)。 */
function readEach<T extends object>(json: unknown, empty: T, shape: Record<string, Parser>): T {
  const src = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...(empty as Record<string, unknown>) };
  for (const key of Object.keys(empty)) {
    if (!(key in src)) continue;
    const r = shape[key].safeParse(src[key]);
    if (r.success) out[key] = r.data;
  }
  return out as T;
}

export function readSnapshot(json: unknown): PropertySnapshot {
  return readEach(json, EMPTY_SNAPSHOT, propertySnapshotSchema.shape);
}

export function readBroker(json: unknown): CounterpartyBroker {
  return readEach(json, EMPTY_BROKER, counterpartyBrokerSchema.shape);
}
