import { PROPERTY_TYPE_LABELS } from "@/lib/property-types";
import {
  EMPTY_BROKER, EMPTY_SNAPSHOT, counterpartyBrokerSchema, propertySnapshotSchema,
  type CounterpartyBroker, type PropertySnapshot,
} from "./schemas";

/** 写しに使う物件の列(+現地担当の範囲判定に使う createdBy/assignedTo)。 */
export const SNAPSHOT_PROPERTY_SELECT = {
  propertyType: true, address: true, lotNumber: true, buildingNumber: true, buildingName: true, roomNo: true,
  exclusiveArea: true, totalFloorArea: true, landArea: true, structureType: true, builtYear: true, builtMonth: true,
  access: true, layoutType: true, createdBy: true, assignedTo: true,
} as const;

type Num = { toString(): string } | number | string | null;
interface SnapshotSource {
  propertyType: string; address: string; lotNumber: string | null; buildingNumber: string | null;
  buildingName: string | null; roomNo: string | null; exclusiveArea: Num; totalFloorArea: Num; landArea: Num;
  structureType: string | null; builtYear: number | null; builtMonth: number | null; access: string | null; layoutType: string | null;
}

const num = (v: Num): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(String(v));
  return Number.isFinite(n) ? n : null;
};
const str = (v: string | null) => (v && v.trim() ? v.trim() : null);

/** 物件 → 写し。住居表示の専用欄は無いので住所を当てる(設計 §1)。土地の権利は物件に無い=空。 */
export function buildSnapshotFromProperty(p: SnapshotSource): PropertySnapshot {
  const isUnit = p.propertyType === "apartment_unit" || p.propertyType === "unit";
  return {
    buildingName: str(p.buildingName), roomNo: str(p.roomNo), address: str(p.address), lotNumber: str(p.lotNumber),
    buildingNumber: str(p.buildingNumber), propertyTypeLabel: PROPERTY_TYPE_LABELS[p.propertyType] ?? null,
    structure: str(p.structureType), builtYear: p.builtYear, builtMonth: p.builtMonth,
    floorArea: num(isUnit ? p.exclusiveArea : p.totalFloorArea), landArea: num(p.landArea), landRight: null,
    access: str(p.access), layout: str(p.layoutType),
  };
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
