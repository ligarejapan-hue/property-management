/**
 * 登記上の記載を画面に渡す形にする(2026-11-12)。
 *
 * ⚠住所は所有者の登記上の住所と同じ機微度=**所有者の住所と同じ表示レベルで伏せる**
 *   (applyDisplayToOwner の address をそのまま使う。専用の伏せ方を作ると、片方だけ生で見える穴になる)。
 * ⚠owner:read が無い人には何も渡さない(呼ぶ側で config=null を渡す)。
 */
import { applyDisplayToOwner, type OwnerDisplayConfig } from "@/lib/display-level";
import { sumRegistryShares, type RegistryShare } from "@/lib/registry-entries/share";

export interface RegistryEntryRecord {
  position: number;
  address: string | null;
  shareNum: number | null;
  shareDen: number | null;
}

export interface RegistryEntryView {
  position: number;
  /** 表示レベルで伏せた後の住所(見せない設定なら null) */
  address: string | null;
  share: RegistryShare | null;
}

export interface RegistryEntriesView {
  entries: RegistryEntryView[];
  /** 持分の合計(約分しない・分母違いは通分)。読めない行があれば null。 */
  shareTotal: RegistryShare | null;
}

function shareOf(e: RegistryEntryRecord): RegistryShare | null {
  return e.shareNum && e.shareDen ? { num: e.shareNum, den: e.shareDen } : null;
}

/**
 * @param config 所有者の表示設定。owner:read が無いときは null を渡す(=何も返さない)
 * @returns 行が無い・見せない人には null
 */
export function buildRegistryEntriesView(
  records: ReadonlyArray<RegistryEntryRecord> | null | undefined,
  config: OwnerDisplayConfig | null,
): RegistryEntriesView | null {
  if (!config || !records || records.length === 0) return null;
  const sorted = [...records].sort((a, b) => a.position - b.position);
  const entries = sorted.map((e) => {
    const masked = applyDisplayToOwner({ name: "", address: e.address }, config).address;
    return {
      position: e.position,
      address: typeof masked === "string" && masked.trim() ? masked : null,
      share: shareOf(e),
    };
  });
  return { entries, shareTotal: sumRegistryShares(sorted.map(shareOf)) };
}
