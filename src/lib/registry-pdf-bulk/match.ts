import { normalizeAddress } from "@/lib/normalize";

/**
 * 所有者事項PDF一括取込の物件突合。
 *
 * ジョブ開始時に全物件を1回だけ読み込んで正規化インデックスを作り、
 * 行ごとの突合は Map lookup のみで行う(行数×全件スキャンを避ける)。
 * 一致判定は既存 Mode B(registry-pdf/process.ts)と同じ優先順:
 *   1. realEstateNumber 完全一致
 *   2. 所在(canonicalAddressKey)完全一致
 * 部分一致による自動添付は誤紐付けリスクがあるため行わない(0件/複数件は要確認へ)。
 */

export interface PropertyIndex {
  byAddress: Map<string, string[]>;
  byRealEstateNumber: Map<string, string[]>;
}

// 実データでは受付帳由来の Property.address に「都道府県」接頭辞と
// 「外N」接尾辞(共同担保等の付随物件数を示す)が付くが、PDFファイル名/内容側の
// 所在にはどちらも付かない。突合キーとしては両方除去した値で揃える。
const PREFECTURE_PREFIX = /^(北海道|東京都|京都府|大阪府|.{2,3}県)/;
const SOTO_SUFFIX = /外\d+$/;

/**
 * 所在の突合用正準化キー。
 *
 * normalizeAddress(NFKC+ハイフン統一)した上で、都道府県接頭辞と末尾の
 * 「外N」を除去する。除去の結果空文字になる場合は突合キーとして使わない
 * (全空同士の誤一致防止のため呼び出し側で "" は not_found / index 未登録とする)。
 */
export function canonicalAddressKey(input: string | null | undefined): string {
  const base = normalizeAddress(input ?? "");
  if (base === "") return "";
  // 「外N」の前に空白がある表記(「…752-3 外3」)でも末尾空白を残さない
  return base.replace(PREFECTURE_PREFIX, "").replace(SOTO_SUFFIX, "").trim();
}

/** realEstateNumber の突合用正規化(全角数字対策で NFKC も適用)。 */
function normalizeRealEstateNumber(input: string | null | undefined): string {
  return (input ?? "").normalize("NFKC").trim();
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
    const addr = canonicalAddressKey(p.address);
    if (addr !== "") {
      const list = byAddress.get(addr) ?? [];
      list.push(p.id);
      byAddress.set(addr, list);
    }
    const ren = normalizeRealEstateNumber(p.realEstateNumber);
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
  const ren = normalizeRealEstateNumber(keys.realEstateNumber);
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
  const addr = canonicalAddressKey(keys.location);
  if (addr === "") return { status: "not_found" };
  const hits = index.byAddress.get(addr);
  if (!hits || hits.length === 0) return { status: "not_found" };
  if (hits.length > 1) return { status: "multiple", count: hits.length };
  return { status: "matched", propertyId: hits[0], matchedBy: "address" };
}
