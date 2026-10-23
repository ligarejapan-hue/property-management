import type { DealUpdateInput } from "./schemas";

/** 変更履歴に残す取引の項目(値が人に読める単純な項目だけ。写しなどの JSON は監査に項目名だけ残す)。 */
export const DEAL_TRACKED_FIELDS = [
  "name", "businessType", "tradeSide", "status", "assigneeId", "licensedAgentId", "salesStaffId", "opsStaffId",
  "propertyKind", "hasOc", "contractAt", "contractPlace", "settlementAt", "settlementPlace",
  "price", "deposit", "taxRateBp",
];

const SIMPLE_KEYS = [
  "name", "businessType", "status", "assigneeId", "licensedAgentId", "salesStaffId", "opsStaffId",
  "propertyKind", "hasOc", "contractPlace", "settlementPlace", "propertySnapshot", "counterpartyBroker",
  "taxRateBp", "assessments", "costs", "settlementTerms", "leases", "overrides",
] as const;
const DATE_KEYS = ["contractAt", "settlementAt"] as const;
const BIGINT_KEYS = ["price", "deposit"] as const;

export function normalizeTradeSide(businessType: string, tradeSide: string | null | undefined): string | null {
  return businessType === "resale" ? null : tradeSide ?? null;
}

/** PATCH の本文 → DB に書く値。送られていない項目は入れない(=触らない)。 */
export function toDealUpdateData(
  patch: Omit<DealUpdateInput, "version">,
  currentBusinessType: string,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const k of SIMPLE_KEYS) if (patch[k] !== undefined) data[k] = patch[k];
  for (const k of DATE_KEYS) {
    const v = patch[k];
    if (v !== undefined) data[k] = v === null ? null : new Date(v);
  }
  for (const k of BIGINT_KEYS) {
    const v = patch[k];
    if (v !== undefined) data[k] = v === null ? null : BigInt(v);
  }
  if (patch.tradeSide !== undefined || patch.businessType !== undefined) {
    const bt = patch.businessType ?? currentBusinessType;
    if (bt === "resale") data.tradeSide = null;
    else if (patch.tradeSide !== undefined) data.tradeSide = patch.tradeSide;
  }
  return data;
}

/** 変更履歴に渡す値(追跡する項目だけ・日時は ISO 文字列=String(Date) の読みにくい形を避ける)。 */
export function dealChangeValues(v: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of DEAL_TRACKED_FIELDS) {
    if (!(k in v)) continue;
    const val = v[k];
    out[k] = val instanceof Date ? val.toISOString() : val;
  }
  return out;
}
