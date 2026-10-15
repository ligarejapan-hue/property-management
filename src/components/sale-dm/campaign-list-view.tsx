import Link from "next/link";
import type { CampaignListItem } from "@/lib/sale-dm-letter/campaign-list";

/** 作成日時を日本時間で「2026/10/15 09:30」の形にする。 */
export function formatCampaignDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}/${get("month")}/${get("day")} ${get("hour")}:${get("minute")}`;
}

/** 送付の進み具合の一言。 */
export function campaignProgressLabel(c: Pick<CampaignListItem, "recipients" | "sent">): string {
  if (c.recipients === 0) return "宛先なし";
  if (c.sent === 0) return "未送付";
  if (c.sent >= c.recipients) return "すべて送付済み";
  return "一部送付済み";
}

/** 発送一覧の見た目(テスト用に切り出し)。 */
export function CampaignListView({ campaigns }: { campaigns: CampaignListItem[] }) {
  if (campaigns.length === 0) {
    return (
      <p className="rounded-md bg-white p-6 text-center text-sm text-gray-500 dark:bg-gray-900 dark:text-gray-400">
        まだ発送を作っていません。
        <Link href="/properties" className="font-semibold underline underline-offset-2">
          物件一覧
        </Link>
        で送る物件を選び、「売却DMを作成」から作れます。
      </p>
    );
  }
  return (
    <ul className="divide-y divide-gray-200 overflow-hidden rounded-lg border border-gray-200 bg-white dark:divide-gray-800 dark:border-gray-800 dark:bg-gray-900">
      {campaigns.map((c) => (
        <li key={c.id}>
          <Link
            href={`/properties/sale-dm/${c.id}`}
            data-testid="sale-dm-campaign-row"
            className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-gray-900 dark:text-gray-100">{c.name}</span>
              <span className="block text-xs text-gray-500 dark:text-gray-400">作成 {formatCampaignDate(c.createdAt)}</span>
            </span>
            <span className="shrink-0 text-right text-xs text-gray-600 dark:text-gray-300">
              <span className="block font-semibold">{campaignProgressLabel(c)}</span>
              <span className="block">
                宛先 {c.recipients}件・送付済み {c.sent}件
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
