import Link from "next/link";
import type { AgentDirectoryRow, AgentHit } from "@/lib/api-client";
import { agentLabel } from "@/lib/agent-inquiry/desk-form";
import { formatJstDate } from "@/lib/agent-inquiry/main-view";

const LIST = "divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white dark:divide-gray-800 dark:border-gray-800 dark:bg-gray-900";
const ROW = "flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-indigo-50/40 dark:hover:bg-indigo-900/20";

/** 名簿の一覧(名前順)。支店名まで・代表電話・反響件数・最終日。押すと詳細。 */
export function AgentDirectoryRows({ rows }: { rows: AgentDirectoryRow[] }) {
  if (rows.length === 0) return <p className="text-sm text-gray-500 dark:text-gray-400">業者がありません。</p>;
  return (
    <ul className={LIST}>
      {rows.map((r) => (
        <li key={r.id}>
          <Link href={`/agents/${r.id}`} className={ROW}>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100">{agentLabel(r)}</span>
              <span className="block text-xs text-gray-500 dark:text-gray-400">代表 {r.phone}</span>
            </span>
            <span className="text-right text-xs text-gray-500 dark:text-gray-400">
              <span className="block">反響 {r.inquiryCount}件</span>
              <span className="block">{r.lastReceivedAt ? `最終 ${formatJstDate(r.lastReceivedAt)}` : "反響なし"}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** 検索の結果(代表電話・携帯・会社名)。しまった業者は出ない。 */
export function AgentSearchHits({ hits }: { hits: AgentHit[] }) {
  return (
    <ul className={LIST}>
      {hits.map((h) => (
        <li key={h.id}>
          <Link href={`/agents/${h.id}`} className={ROW}>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100">{agentLabel(h)}</span>
              <span className="block text-xs text-gray-500 dark:text-gray-400">
                代表 {h.phone}
                {/* リンクの中の個人情報には自前の印を付ける(画面保護は押せる要素の中を外から見ない)。 */}
                {h.lastContact?.name && (
                  <span data-pii-protected="true" data-pii-surface="dashboard">{` ・ 前回 ${h.lastContact.name}様`}</span>
                )}
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
