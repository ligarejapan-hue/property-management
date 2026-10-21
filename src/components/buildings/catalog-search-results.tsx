/** 「マンション棟」の検索の2段目=名簿にあるマンション(設計 2026-10-18 §6.3)。表示専用(SSR テストのため切り出す)。 */
import { Button } from "@/components/ui/button";
import { catalogSearchLine, type CatalogSearchItem } from "@/lib/mansion-catalog/search";

export type { CatalogSearchItem };

export function CatalogSearchResults({
  items, canAdopt, adoptingId, error, onAdopt,
}: {
  items: CatalogSearchItem[];
  /** 物件を書き込める人(property:write)だけ登録ボタンを出す。⚠サーバーも同じ権限で止める。 */
  canAdopt: boolean;
  adoptingId: string | null;
  error: string | null;
  onAdopt: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section className="mt-6">
      <h2 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-300">名簿にあるマンション（{items.length}件）</h2>
      <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
        まだマンション棟になっていない建物です。{canAdopt ? "登録すると、竣工年月・階数・戸数などが入った棟ができます。" : ""}
      </p>
      {error && <p role="alert" className="mb-2 text-sm text-red-700 dark:text-red-300">{error}</p>}
      <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white dark:divide-gray-800 dark:border-gray-800 dark:bg-gray-900">
        {items.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <div className="min-w-0">
              <p className="font-medium text-gray-900 dark:text-gray-100">{i.name}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">{i.address}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">{catalogSearchLine(i)}</p>
            </div>
            {canAdopt && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onAdopt(i.id)}
                disabled={adoptingId !== null}
              >
                {adoptingId === i.id ? "登録しています…" : "マンション棟に登録"}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
