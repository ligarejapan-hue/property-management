"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Inbox } from "lucide-react";
import { fetchSaleDmInquiries, updateSaleDmInquiryStatus, type SaleDmCampaign, type SaleDmInquiry } from "@/lib/api-client";

const STATUS_OPTIONS: Array<{ value: SaleDmInquiry["handleStatus"]; label: string }> = [
  { value: "open", label: "未対応" },
  { value: "in_progress", label: "対応中" },
  { value: "done", label: "対応済み" },
];
const PREF_LABEL: Record<string, string> = { phone: "電話", email: "メール", either: "どちらでも" };

function formatJst(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** キャンペーン画面の「査定申込」一覧(設計 §2.5)。未対応が上。対応状況はその場で変更できる。 */
export default function SaleDmInquiryList({ campaign, reloadKey }: { campaign: SaleDmCampaign; reloadKey: number }) {
  const [items, setItems] = useState<SaleDmInquiry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // 先頭ページを取得して置き換える(初回・reloadKey 変化・対応状況の変更後)。
  // 対応状況が変わると行がページをまたいで移動しうるので、常に先頭ページへ戻す。
  const load = useCallback(async () => {
    try {
      const res = await fetchSaleDmInquiries(campaign.id);
      setItems(res.inquiries);
      setNextOffset(res.nextOffset);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "申込を読み込めませんでした");
    }
  }, [campaign.id]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const loadMore = async () => {
    if (nextOffset === null) return;
    setLoadingMore(true);
    try {
      const res = await fetchSaleDmInquiries(campaign.id, nextOffset);
      setItems((prev) => {
        const existingIds = new Set((prev ?? []).map((i) => i.id));
        const added = res.inquiries.filter((i) => !existingIds.has(i.id));
        return [...(prev ?? []), ...added];
      });
      setNextOffset(res.nextOffset);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "申込を読み込めませんでした");
    } finally {
      setLoadingMore(false);
    }
  };

  const recipientName = (draftId: string) => {
    const r = campaign.recipients.find((x) => x.id === draftId);
    return r ? `${r.recipientName} ${r.honorific}` : "(表示範囲外の宛先)";
  };

  const changeStatus = async (id: string, handleStatus: SaleDmInquiry["handleStatus"]) => {
    setBusyId(id);
    try {
      await updateSaleDmInquiryStatus(id, { handleStatus });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "対応状況を変更できませんでした");
    } finally {
      setBusyId(null);
    }
  };

  const openCount = items?.filter((i) => i.handleStatus === "open").length ?? 0;

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
      <div className="mb-3 flex items-center gap-2">
        <Inbox className="h-4 w-4 text-gray-500" />
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">査定申込</h2>
        {items && (
          <span className="text-xs text-gray-500">
            {items.length}件表示{nextOffset !== null ? "(続きあり)" : ""}
            {openCount > 0 ? `・表示中の未対応 ${openCount}件` : ""}
          </span>
        )}
      </div>
      {error && (
        <p className="mb-2 flex flex-wrap items-center gap-2 text-xs text-red-600" role="alert">
          <span>{error}</span>
          {items === null && (
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
            >
              再読み込み
            </button>
          )}
        </p>
      )}
      {items === null && !error ? (
        <Loader2 className="h-4 w-4 animate-spin text-indigo-500" />
      ) : items === null ? null : items.length === 0 ? (
        <p className="py-4 text-center text-sm text-gray-500">申込はまだありません</p>
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800" data-pii-protected data-pii-surface="owner">
          {items.map((i) => (
            <li key={i.id} className="py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-gray-500">{formatJst(i.submittedAt)}</span>
                <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">{i.name}</span>
                <span className="text-xs text-gray-500">宛先: {recipientName(i.draftId)}</span>
                <select
                  value={i.handleStatus}
                  disabled={busyId === i.id}
                  onChange={(e) => void changeStatus(i.id, e.target.value as SaleDmInquiry["handleStatus"])}
                  className="ml-auto rounded-md border border-gray-300 px-1.5 py-1 text-xs dark:border-gray-700 dark:bg-gray-900"
                  aria-label="対応状況"
                >
                  {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              {i.contactHidden ? (
                <p className="mt-1 text-xs text-gray-500">連絡先を表示する権限がありません</p>
              ) : (
                <dl className="mt-1 grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-0.5 text-xs text-gray-700 dark:text-gray-300">
                  <dt className="text-gray-500">電話</dt><dd>{i.phone}</dd>
                  {i.email && (<><dt className="text-gray-500">メール</dt><dd className="break-all">{i.email}</dd></>)}
                  {i.contactPref && (<><dt className="text-gray-500">希望の連絡方法</dt><dd>{PREF_LABEL[i.contactPref] ?? i.contactPref}</dd></>)}
                  {i.contactTime && (<><dt className="text-gray-500">時間帯</dt><dd>{i.contactTime}</dd></>)}
                  {i.message && (<><dt className="text-gray-500">要望</dt><dd className="whitespace-pre-wrap">{i.message}</dd></>)}
                </dl>
              )}
            </li>
          ))}
        </ul>
      )}
      {nextOffset !== null && (
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            さらに表示
          </button>
        </div>
      )}
    </div>
  );
}
