import { formatShare, type RegistryShare } from "@/lib/registry-entries/share";

/**
 * 登記上の記載(所有者事項の行ごとの住所と持分・2026-11-12 発注者決定)の見た目。
 *
 * - 持分の札: 所有者全員に出す(共有者も・行が1つだけの人も)。合計が出せない人には出さない。
 * - 内訳の表: 行が2つ以上の人だけ(同じ人が住所違い・持分ごとに何行も載っているとき)。
 * ⚠所有者事項の行の順に新旧の意味は無い=「最新の住所」とは書かない。
 * ⚠住所は API が所有者の住所と同じ表示レベルで伏せてから渡す。ここでは渡された字をそのまま出す。
 */
export interface RegistryEntriesViewProps {
  entries: Array<{ position: number; address: string | null; share: RegistryShare | null }>;
  shareTotal: RegistryShare | null;
}

/** 見出しの札「持分 7/10」。合計が無ければ何も出さない。 */
export function RegistryShareBadge({ registry }: { registry: RegistryEntriesViewProps | null | undefined }) {
  if (!registry?.shareTotal) return null;
  return (
    <span
      className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-bold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-200"
      title="所有者事項から読んだ持分(行が複数あるときは合計)"
    >
      持分 {formatShare(registry.shareTotal)}
    </span>
  );
}

/** 内訳の表。行が2つ以上のときだけ出す。 */
export function RegistryEntriesPanel({ registry }: { registry: RegistryEntriesViewProps | null | undefined }) {
  if (!registry || registry.entries.length < 2) return null;
  return (
    <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-900/40">
      <p className="mb-2 text-xs font-semibold text-gray-700 dark:text-gray-200">
        登記上の記載（所有者事項に {registry.entries.length} 行）
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 dark:text-gray-400">
              <th className="w-10 py-1 pr-2 font-medium">行</th>
              <th className="py-1 pr-2 font-medium">登記上の住所</th>
              <th className="w-24 py-1 font-medium">持分</th>
            </tr>
          </thead>
          <tbody>
            {registry.entries.map((e) => (
              <tr key={e.position} className="border-t border-gray-200 dark:border-gray-800">
                <td className="py-1 pr-2 text-gray-500 dark:text-gray-400">{e.position}</td>
                <td className="py-1 pr-2 text-gray-900 dark:text-gray-100">{e.address ?? "-"}</td>
                <td className="py-1 text-gray-900 dark:text-gray-100">{e.share ? formatShare(e.share) : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
        同じ方が、住所や持分ごとに分けて登記されています。どの住所が今のお住まいかは、所有者事項からは分かりません。
      </p>
    </div>
  );
}
