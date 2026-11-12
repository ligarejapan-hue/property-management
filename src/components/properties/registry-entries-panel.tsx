import { formatShare, type RegistryShare } from "@/lib/registry-entries/share";
import { normalizeAddress } from "@/lib/normalize";
import { Button } from "@/components/ui/button";

/**
 * 登記上の記載(所有者事項の行ごとの住所と持分・2026-11-12 発注者決定)の見た目。
 *
 * - 持分の札: 所有者全員に出す(共有者も・行が1つだけの人も)。合計が出せない人には出さない。
 * - 内訳の表: 行が2つ以上の人だけ(同じ人が住所違い・持分ごとに何行も載っているとき)。
 * - 「この住所を宛先にする」(第2回): 押すと所有者の編集が開き、登記上の住所にその行の住所が入る
 *   (郵便番号は空)。保存で確定=保存の入口・権限・編集中の鍵・変更履歴は所有者の編集と同じ。
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

interface RegistryEntriesPanelProps {
  registry: RegistryEntriesViewProps | null | undefined;
  /** 所有者の今の登記上の住所(同じ住所の行に「今の宛先」と出す)。 */
  ownerAddress?: string | null;
  /** 現住所が入っているか(入っていれば DM は現住所あて=その旨を出す)。 */
  hasCurrentAddress?: boolean;
  /**
   * 「この住所を宛先にする」。渡されたときだけボタンを出す(住所と郵便番号を編集できる人・
   * 編集中でない・ほかの人が編集中でない、は呼ぶ側で決める)。
   */
  onUseAddress?: (address: string) => void;
}

/** 同じ住所か(書き方の違い=全角半角・空白・ハイフンはそろえて比べる)。 */
function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a?.trim() || !b?.trim()) return false;
  return normalizeAddress(a) === normalizeAddress(b);
}

/** 内訳の表。行が2つ以上のときだけ出す。 */
export function RegistryEntriesPanel({
  registry,
  ownerAddress,
  hasCurrentAddress,
  onUseAddress,
}: RegistryEntriesPanelProps) {
  if (!registry || registry.entries.length < 2) return null;
  const showAction = onUseAddress !== undefined || ownerAddress !== undefined;
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
              {showAction && <th className="w-44 py-1 font-medium" aria-label="宛先" />}
            </tr>
          </thead>
          <tbody>
            {registry.entries.map((e) => {
              const isCurrent = sameAddress(e.address, ownerAddress);
              return (
                <tr key={e.position} className="border-t border-gray-200 dark:border-gray-800">
                  <td className="py-1 pr-2 text-gray-500 dark:text-gray-400">{e.position}</td>
                  <td className="py-1 pr-2 text-gray-900 dark:text-gray-100">{e.address ?? "-"}</td>
                  <td className="py-1 text-gray-900 dark:text-gray-100">{e.share ? formatShare(e.share) : "-"}</td>
                  {showAction && (
                    <td className="py-1 text-right">
                      {isCurrent ? (
                        <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-bold text-green-700 dark:bg-green-950 dark:text-green-200">
                          今の宛先
                        </span>
                      ) : onUseAddress && e.address?.trim() ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => onUseAddress(e.address!)}
                          title="所有者の編集が開き、登記上の住所にこの住所が入ります（郵便番号は空になります）。保存で確定します。"
                        >
                          この住所を宛先にする
                        </Button>
                      ) : null}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
        同じ方が、住所や持分ごとに分けて登記されています。どの住所が今のお住まいかは、所有者事項からは分かりません。
        {onUseAddress && "「この住所を宛先にする」を押すと所有者の編集が開くので、保存で確定してください。"}
        {hasCurrentAddress && "現住所が入っているので、DM は現住所あてに出ます。"}
      </p>
    </div>
  );
}
