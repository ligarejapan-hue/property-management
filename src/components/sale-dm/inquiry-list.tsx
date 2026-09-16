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

type Segment = "active" | "done";

// 追加ページは id で重複を除いて後ろにつなぐ。
function appendUnique(prev: SaleDmInquiry[] | null, added: SaleDmInquiry[]): SaleDmInquiry[] {
  const existingIds = new Set((prev ?? []).map((i) => i.id));
  return [...(prev ?? []), ...added.filter((i) => !existingIds.has(i.id))];
}

/**
 * キャンペーン画面の「査定申込」一覧(設計 §2.5)。
 * 「対応が必要」(未対応・対応中)を先に出し、「対応済み」は押したときだけ読む。
 * 区分ごとにカーソルでたどる(@codex P2: 途中で申込が届いても・状態が変わっても重複や取りこぼしが出ない)。
 */
export default function SaleDmInquiryList({ campaign, reloadKey }: { campaign: SaleDmCampaign; reloadKey: number }) {
  // 対応が必要(未対応・対応中)
  const [items, setItems] = useState<SaleDmInquiry[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  // 対応済み(押すまで読まない。null=未読込)
  const [doneItems, setDoneItems] = useState<SaleDmInquiry[] | null>(null);
  const [doneNextCursor, setDoneNextCursor] = useState<string | null>(null);
  const [loadingDone, setLoadingDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState<Segment | null>(null);
  // 先頭から読み直した後に古い「さらに表示」の応答が混ざらないよう、区分ごとに世代を数える。
  const generation = useRef<Record<Segment, number>>({ active: 0, done: 0 });
  const doneOpen = doneItems !== null;

  // 「対応が必要」の先頭ページを取得して置き換える(初回・reloadKey 変化・対応状況の変更後)。
  const load = useCallback(async () => {
    const gen = ++generation.current.active;
    try {
      const res = await fetchSaleDmInquiries(campaign.id, "active");
      if (gen !== generation.current.active) return;
      setItems(res.inquiries);
      setNextCursor(res.nextCursor);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "申込を読み込めませんでした");
    }
  }, [campaign.id]);

  // 「対応済み」の先頭ページを取得して置き換える(「対応済みを表示」・開いている間の読み直し)。
  const loadDone = useCallback(async () => {
    const gen = ++generation.current.done;
    setLoadingDone(true);
    try {
      const res = await fetchSaleDmInquiries(campaign.id, "done");
      if (gen !== generation.current.done) return;
      setDoneItems(res.inquiries);
      setDoneNextCursor(res.nextCursor);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "対応済みの申込を読み込めませんでした");
    } finally {
      setLoadingDone(false);
    }
  }, [campaign.id]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const loadMore = async (segment: Segment) => {
    const cursor = segment === "active" ? nextCursor : doneNextCursor;
    if (cursor === null) return;
    const gen = generation.current[segment];
    setLoadingMore(segment);
    try {
      const res = await fetchSaleDmInquiries(campaign.id, segment, cursor);
      if (gen !== generation.current[segment]) return;
      if (segment === "active") {
        setItems((prev) => appendUnique(prev, res.inquiries));
        setNextCursor(res.nextCursor);
      } else {
        setDoneItems((prev) => appendUnique(prev, res.inquiries));
        setDoneNextCursor(res.nextCursor);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "申込を読み込めませんでした");
    } finally {
      setLoadingMore(null);
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
      // 行が区分をまたいで移動するので先頭から読み直す(対応済みは開いているときだけ)。
      await Promise.all([load(), doneOpen ? loadDone() : Promise.resolve()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "対応状況を変更できませんでした");
    } finally {
      setBusyId(null);
    }
  };

  const openCount = items?.filter((i) => i.handleStatus === "open").length ?? 0;

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

  const renderMore = (segment: Segment, cursor: string | null) =>
    cursor !== null && (
      <div className="mt-3 flex justify-center">
        <button
          type="button"
          onClick={() => void loadMore(segment)}
          disabled={loadingMore === segment}
          className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          さらに表示
        </button>
      </div>
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
          <h3 className="text-xs font-semibold text-gray-700 dark:text-gray-200">対応が必要</h3>
          {items && (
            <span className="text-xs text-gray-500">
              {items.length}件表示{nextCursor !== null ? "(続きあり)" : ""}
              {openCount > 0 ? `・表示中の未対応 ${openCount}件` : ""}
            </span>
          )}
        </div>
        {items === null && !error ? (
          <Loader2 className="h-4 w-4 animate-spin text-indigo-500" />
        ) : items === null ? null : items.length === 0 ? (
          <p className="py-4 text-center text-sm text-gray-500">対応が必要な申込はありません</p>
        ) : (
          renderList(items)
        )}
        {renderMore("active", nextCursor)}
      </section>

      <section className="mt-4 border-t border-gray-100 pt-3 dark:border-gray-800">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <h3 className="text-xs font-semibold text-gray-700 dark:text-gray-200">対応済み</h3>
          {doneItems && (
            <span className="text-xs text-gray-500">
              {doneItems.length}件表示{doneNextCursor !== null ? "(続きあり)" : ""}
            </span>
          )}
        </div>
        {doneItems === null ? (
          <button
            type="button"
            onClick={() => void loadDone()}
            disabled={loadingDone}
            className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {loadingDone && <Loader2 className="h-3 w-3 animate-spin" />}
            対応済みを表示
          </button>
        ) : doneItems.length === 0 ? (
          <p className="py-4 text-center text-sm text-gray-500">対応済みの申込はありません</p>
        ) : (
          renderList(doneItems)
        )}
        {doneItems !== null && renderMore("done", doneNextCursor)}
      </section>
    </div>
  );
}
