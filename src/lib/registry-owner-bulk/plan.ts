/**
 * まとめて反映の「今回処理する件数」と行の組み立て（ピュア）。
 *
 * ⚠件数の既定は**少なめ**にする。まず少しだけ流して登録内容を見てから増やす、が
 *   発注者承認の進め方(2026-09-26)。増やすのは人が数字を入れたときだけ。
 */
import {
  buildRegistryOwnerApplyRawData,
} from "@/lib/registry-owner-bulk/marker";

/** 指定が無いときの件数。 */
export const REGISTRY_OWNER_APPLY_DEFAULT_LIMIT = 100;

/**
 * 一度に流せる上限。
 * 現在の対象は1,821件(本番実測 2026-09-26)なので「全件」も1回で流せる。
 * ⚠上限を外さない: 取り違えて桁を増やしても、被害が上限で止まる。
 */
export const REGISTRY_OWNER_APPLY_MAX_LIMIT = 5000;

/**
 * 受け取った件数を検査する。
 * 未指定 → 既定。1以上・上限以下の整数 → その値。それ以外 → `null`(不正=受け付けない)。
 * ⚠黙って直さない(丸めない)。人が入れた数と流れる件数が違う状態を作らない。
 */
export function parseRegistryOwnerApplyLimit(raw: unknown): number | null {
  if (raw === undefined || raw === null) return REGISTRY_OWNER_APPLY_DEFAULT_LIMIT;
  if (typeof raw !== "number" || !Number.isInteger(raw)) return null;
  if (raw < 1 || raw > REGISTRY_OWNER_APPLY_MAX_LIMIT) return null;
  return raw;
}

export interface RegistryOwnerApplyTarget {
  id: string;
  address: string | null;
}

export interface RegistryOwnerApplyRowSeed {
  rowNumber: number;
  status: "pending";
  rawData: Record<string, string>;
}

/**
 * 対象の物件から取込記録の行を作る。
 * ⚠同じ物件は1行だけにする(二重に処理しても2件目は「すでに所有者あり」で飛ばされるが、
 *   結果の一覧が読みにくくなる)。
 */
export function buildRegistryOwnerApplyRowSeeds(
  targets: RegistryOwnerApplyTarget[],
): RegistryOwnerApplyRowSeed[] {
  const seen = new Set<string>();
  const seeds: RegistryOwnerApplyRowSeed[] = [];
  for (const target of targets) {
    if (seen.has(target.id)) continue;
    seen.add(target.id);
    seeds.push({
      rowNumber: seeds.length + 1,
      status: "pending",
      rawData: buildRegistryOwnerApplyRawData({
        propertyId: target.id,
        address: target.address,
      }),
    });
  }
  return seeds;
}
