"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

// 追加ページは id で重複を除いて後ろにつなぐ(API の並び順を保つ)。
function appendUnique(prev: SaleDmInquiry[] | null, added: SaleDmInquiry[]): SaleDmInquiry[] {
  const existingIds = new Set((prev ?? []).map((i) => i.id));
  return [...(prev ?? []), ...added.filter((i) => !existingIds.has(i.id))];
}

/**
 * キャンペーン画面の「査定申込」一覧(設計 §2.5)。
 * 状態で絞らない1本のカーソルで新しい順に読み込み、画面で「対応が必要」(未対応・対応中)と
 * 「対応済み」に振り分ける(@codex P2: 途中で状態が変わっても取りこぼさない)。
 * 読み込んでいない古いページに残りがあるかは counts(状態別の件数)で知らせる。
 */
export default function SaleDmInquiryList({ campaign, reloadKey }: { campaign: SaleDmCampaign; reloadKey: number }) {
  // 読み込んだ全行(API の順・id で重複なし)
  const [items, setItems] = useState<SaleDmInquiry[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [counts, setCounts] = useState<{ active: number; done: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // 対応済みは既定で畳む(読み込み済みの行を出し入れするだけ・取得はしない)
  const [showDone, setShowDone] = useState(false);
  // 先頭から読み直した後に古い「さらに読み込む」の応答が混ざらないよう、世代を数える。
  const generation = useRef(0);

  // 先頭ページを取得して置き換える(初回・reloadKey 変化・対応状況の変更後)。
  const load = useCallback(async () => {
    const gen = ++generation.current;
    try {
      const res = await fetchSaleDmInquiries(campaign.id);
      if (gen !== generation.current) return;
      setItems(res.inquiries);
      setNextCursor(res.nextCursor);
      setCounts(res.counts);
      setError(null);
    } catch (e) {
      if (gen !== generation.current) return;
      setError(e instanceof Error ? e.message : "申込を読み込めませんでした");
    }
  }, [campaign.id]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const loadMore = async () => {
    if (nextCursor === null || loadingMore) return;
    const gen = generation.current;
    setLoadingMore(true);
    try {
      const res = await fetchSaleDmInquiries(campaign.id, nextCursor);
      if (gen !== generation.current) return;
      setItems((prev) => appendUnique(prev, res.inquiries));
      setNextCursor(res.nextCursor);
      setCounts(res.counts);
      setError(null);
    } catch (e) {
      if (gen !== generation.current) return;
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
      // 件数と振り分けが変わるので先頭から読み直す。
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "対応状況を変更できませんでした");
    } finally {
      setBusyId(null);
    }
  };

  const activeItems = items?.filter((i) => i.handleStatus !== "done") ?? [];
  const doneItems = items?.filter((i) => i.handleStatus === "done") ?? [];
  const openCount = activeItems.filter((i) => i.handleStatus === "open").length;
  const activeUnloaded = counts !== null && activeItems.length < counts.active;
  const doneUnloaded = counts !== null && doneItems.length < counts.done;

  const renderList = (list: SaleDmInquiry[]) => (
    <ul className="divide-y divide-gray-100 dark:divide-gray-800" data-pii-protected data-pii-surface="owner">
      {list.map((i) => (
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
              {i.emailHidden ? (
                <><dt className="text-gray-500">メール</dt><dd className="text-gray-400">表示する権限がありません</dd></>
              ) : (
                i.email && (<><dt className="text-gray-500">メール</dt><dd className="break-all">{i.email}</dd></>)
              )}
              {i.contactPref && (<><dt className="text-gray-500">希望の連絡方法</dt><dd>{PREF_LABEL[i.contactPref] ?? i.contactPref}</dd></>)}
              {i.contactTime && (<><dt className="text-gray-500">時間帯</dt><dd>{i.contactTime}</dd></>)}
              {i.message && (<><dt className="text-gray-500">要望</dt><dd className="whitespace-pre-wrap">{i.message}</dd></>)}
            </dl>
          )}
        </li>
      ))}
    </ul>
  );

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
      <div className="mb-3 flex items-center gap-2">
        <Inbox className="h-4 w-4 text-gray-500" />
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">査定申込</h2>
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

      <section>
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <h3 className="text-xs font-semibold text-gray-700 dark:text-gray-200">
            対応が必要{counts !== null ? ` ${counts.active}件` : ""}
          </h3>
          {openCount > 0 && <span className="text-xs text-gray-500">表示中の未対応 {openCount}件</span>}
        </div>
        {activeUnloaded && (
          <p className="mb-1 text-xs text-amber-700 dark:text-amber-400">
            まだ読み込んでいない古い申込にも対応が必要なものがあります。下の「さらに読み込む」で表示します。
          </p>
        )}
        {items === null && !error ? (
          <Loader2 className="h-4 w-4 animate-spin text-indigo-500" />
        ) : items === null ? null : activeItems.length > 0 ? (
          renderList(activeItems)
        ) : counts?.active === 0 ? (
          <p className="py-4 text-center text-sm text-gray-500">対応が必要な申込はありません</p>
        ) : null}
      </section>

      {items !== null && (
        <section className="mt-4 border-t border-gray-100 pt-3 dark:border-gray-800">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <h3 className="text-xs font-semibold text-gray-700 dark:text-gray-200">対応済み</h3>
            <button
              type="button"
              onClick={() => setShowDone((v) => !v)}
              aria-expanded={showDone}
              className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
            >
              {showDone ? "対応済みを隠す" : `対応済みを表示(${counts?.done ?? 0}件)`}
            </button>
          </div>
          {showDone && (
            <>
              {doneItems.length > 0
                ? renderList(doneItems)
                : counts?.done === 0 && <p className="py-4 text-center text-sm text-gray-500">対応済みの申込はありません</p>}
              {doneUnloaded && (
                <p className="mt-1 text-xs text-gray-500">古い対応済みの申込は「さらに読み込む」で表示します。</p>
              )}
            </>
          )}
        </section>
      )}

      {nextCursor !== null && (
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {loadingMore && <Loader2 className="h-3 w-3 animate-spin" />}
            さらに読み込む
          </button>
        </div>
      )}
    </div>
  );
}
