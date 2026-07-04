import { normalizeAddress } from "@/lib/normalize";

/**
 * 所有者事項PDF一括取込の物件突合。
 *
 * ジョブ開始時に全物件を1回だけ読み込んで正規化インデックスを作り、
 * 行ごとの突合は Map lookup のみで行う(行数×全件スキャンを避ける)。
 * 一致判定は既存 Mode B(registry-pdf/process.ts)と同じ優先順:
 *   1. realEstateNumber 完全一致
 *   2. 所在(normalizeAddress)完全一致
 * 部分一致による自動添付は誤紐付けリスクがあるため行わない(0件/複数件は要確認へ)。
 */

export interface PropertyIndex {
  byAddress: Map<string, string[]>;
  byRealEstateNumber: Map<string, string[]>;
}

export function buildPropertyIndex(
  properties: Array<{
    id: string;
    address: string;
    realEstateNumber: string | null;
  }>,
): PropertyIndex {
  const byAddress = new Map<string, string[]>();
  const byRealEstateNumber = new Map<string, string[]>();
  for (const p of properties) {
    const addr = normalizeAddress(p.address);
    if (addr !== "") {
      const list = byAddress.get(addr) ?? [];
      list.push(p.id);
      byAddress.set(addr, list);
    }
    const ren = (p.realEstateNumber ?? "").trim();
    if (ren !== "") {
      const list = byRealEstateNumber.get(ren) ?? [];
      list.push(p.id);
      byRealEstateNumber.set(ren, list);
    }
  }
  return { byAddress, byRealEstateNumber };
}

export type PropertyMatchResult =
  | {
      status: "matched";
      propertyId: string;
      matchedBy: "address" | "real_estate_number";
    }
  | { status: "not_found" }
  | { status: "multiple"; count: number };

export function matchProperty(
  index: PropertyIndex,
  keys: { location?: string | null; realEstateNumber?: string | null },
): PropertyMatchResult {
  const ren = (keys.realEstateNumber ?? "").trim();
  if (ren !== "") {
    const hits = index.byRealEstateNumber.get(ren);
    if (hits && hits.length === 1) {
      return {
        status: "matched",
        propertyId: hits[0],
        matchedBy: "real_estate_number",
      };
    }
    if (hits && hits.length > 1) {
      return { status: "multiple", count: hits.length };
    }
    // 番号不一致は所在フォールバックへ
  }
  const addr = normalizeAddress(keys.location ?? "");
  if (addr === "") return { status: "not_found" };
  const hits = index.byAddress.get(addr);
  if (!hits || hits.length === 0) return { status: "not_found" };
  if (hits.length > 1) return { status: "multiple", count: hits.length };
  return { status: "matched", propertyId: hits[0], matchedBy: "address" };
}
