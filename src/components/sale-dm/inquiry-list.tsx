"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Inbox } from "lucide-react";
import {
  fetchSaleDmInquiries,
  getAllSaleDmInquiries,
  updateSaleDmInquiryStatus,
  resendSaleDmInquiryNotify,
  type SaleDmCampaign,
  type SaleDmInquiry,
  type SaleDmInquiryAcrossCampaigns,
} from "@/lib/api-client";

const STATUS_OPTIONS: Array<{ value: SaleDmInquiry["handleStatus"]; label: string }> = [
  { value: "open", label: "未対応" },
  { value: "in_progress", label: "対応中" },
  { value: "done", label: "対応済み" },
];
const PREF_LABEL: Record<string, string> = { phone: "電話", email: "メール", either: "どちらでも" };

// 一覧の1行の形。campaign モード(SaleDmInquiry)・all モード(SaleDmInquiryAcrossCampaigns)の
// どちらの応答もそのまま items に積めるよう、横断項目は任意にしておく。
type InquiryRow = SaleDmInquiry & Partial<Pick<SaleDmInquiryAcrossCampaigns, "campaignId" | "campaignName" | "location" | "propertyTypeLabel">>;

function formatJst(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// 追加ページは id で重複を除いて後ろにつなぐ(API の並び順を保つ)。
function appendUnique(prev: InquiryRow[] | null, added: InquiryRow[]): InquiryRow[] {
  const existingIds = new Set((prev ?? []).map((i) => i.id));
  return [...(prev ?? []), ...added.filter((i) => !existingIds.has(i.id))];
}

// mode を判別子にした discriminated union(fix round 1・Important #4)。campaign モードでは
// campaign が必須(省略すると型エラー)、all モードでは campaign を渡せない(渡すと型エラー)。
// 「campaign を忘れた campaign モード呼び出しが黙って空一覧になる」を型で防ぐ。
type SaleDmInquiryListProps =
  | {
      mode?: "campaign";
      /** campaign モード必須(宛先名の参照元)。 */
      campaign: SaleDmCampaign;
      reloadKey?: number;
      focusId?: never;
    }
  | {
      mode: "all";
      campaign?: never;
      reloadKey?: number;
      /** `?focus=<inquiryId>` で開いたときに強調・スクロールする対象。 */
      focusId?: string | null;
    };

/**
 * 「査定申込」一覧(設計 §2.5・発注者判断 2026-09-18)。
 * mode="campaign"(既定): 従来どおりキャンペーン画面のパネル(campaign.recipients から宛先名を引く)。
 * 通知の失敗札・再送ボタンも campaign モードに出る(コントローラー裁定2026-09-19: 作成者が
 * 自分の画面から再送できることが目的で、cross-campaign 専用ではない)。
 * mode="all": 「査定の申込」画面(横断)。キャンペーン作成者に限らず、売却DMを使える人は誰でも見て
 * 対応できる。行に宛先名の代わりにキャンペーン名・所在(町名まで)・種別を出し、通知メールの
 * 送信先が居ない(notifyRecipientCount===0)ときの案内は**こちらだけ**に出す(campaign モードの
 * 応答には notifyRecipientCount が無い)。
 * 状態で絞らない1本のカーソルで新しい順に読み込み、画面で「対応が必要」(未対応・対応中)と
 * 「対応済み」に振り分ける(@codex P2: 途中で状態が変わっても取りこぼさない)。
 * 読み込んでいない古いページに残りがあるかは counts(状態別の件数)で知らせる。
 */
export default function SaleDmInquiryList(props: SaleDmInquiryListProps) {
  const mode = props.mode ?? "campaign";
  const campaign = props.mode === "all" ? undefined : props.campaign;
  const reloadKey = props.reloadKey ?? 0;
  const focusId = props.mode === "all" ? (props.focusId ?? null) : null;
  // 読み込んだ全行(API の順・id で重複なし)
  const [items, setItems] = useState<InquiryRow[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [counts, setCounts] = useState<{ active: number; done: number } | null>(null);
  // 通知メールの宛先数(all モードの応答のみ持つ)。null=まだ取得していない。
  const [notifyRecipientCount, setNotifyRecipientCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // 再送を押した直後の申込 id(「通知を送り直しています」表示・数秒後に自動で外れる)。
  const [resendingIds, setResendingIds] = useState<Set<string>>(new Set());
  // 再送の失敗(409/404等)を行ごとに持つ(fix round 1・Minor #3: パネル全体のエラー帯ではなく
  // 該当行に出す)。id をキーにした Record。
  const [resendErrors, setResendErrors] = useState<Record<string, string>>({});
  // 対応済みは既定で畳む(読み込み済みの行を出し入れするだけ・取得はしない)
  const [showDone, setShowDone] = useState(false);
  // すでに focus 行までスクロールしたか(再読込のたびに繰り返さない)。
  const hasScrolledToFocus = useRef(false);
  // 先頭から読み直した後に古い「さらに読み込む」の応答が混ざらないよう、世代を数える。
  const generation = useRef(0);

  // 先頭ページを取得して置き換える(初回・reloadKey 変化・対応状況の変更後)。
  const load = useCallback(async () => {
    const gen = ++generation.current;
    try {
      if (mode === "all") {
        const res = await getAllSaleDmInquiries();
        if (gen !== generation.current) return;
        setItems(res.inquiries);
        setNextCursor(res.nextCursor);
        setCounts(res.counts);
        setNotifyRecipientCount(res.notifyRecipientCount);
      } else if (campaign) {
        const res = await fetchSaleDmInquiries(campaign.id);
        if (gen !== generation.current) return;
        setItems(res.inquiries);
        setNextCursor(res.nextCursor);
        setCounts(res.counts);
      }
      setError(null);
    } catch (e) {
      if (gen !== generation.current) return;
      setError(e instanceof Error ? e.message : "申込を読み込めませんでした");
    }
    // campaign.id だけを見る(参照が毎回変わっても不要な再生成をしない)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, campaign?.id]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const loadMore = async () => {
    if (nextCursor === null || loadingMore) return;
    const gen = generation.current;
    setLoadingMore(true);
    try {
      if (mode === "all") {
        const res = await getAllSaleDmInquiries(nextCursor);
        if (gen !== generation.current) return;
        setItems((prev) => appendUnique(prev, res.inquiries));
        setNextCursor(res.nextCursor);
        setCounts(res.counts);
        setNotifyRecipientCount(res.notifyRecipientCount);
      } else if (campaign) {
        const res = await fetchSaleDmInquiries(campaign.id, nextCursor);
        if (gen !== generation.current) return;
        setItems((prev) => appendUnique(prev, res.inquiries));
        setNextCursor(res.nextCursor);
        setCounts(res.counts);
      }
      setError(null);
    } catch (e) {
      if (gen !== generation.current) return;
      setError(e instanceof Error ? e.message : "申込を読み込めませんでした");
    } finally {
      setLoadingMore(false);
    }
  };

  const recipientName = (draftId: string) => {
    if (!campaign) return "";
    const r = campaign.recipients.find((x) => x.id === draftId);
    return r ? `${r.recipientName} ${r.honorific}` : "(表示範囲外の宛先)";
  };

  // 通知メールの再送(notifyStatus==="failed" の行のみ・resend route が 409 で弾く)。
  // 成功したら数秒待ってから読み直し、実際の送信結果(sent/失敗)を反映する。
  // 失敗はパネル全体のエラー帯(setError)ではなく、該当行にだけ出す(resendErrors)。
  const resendNotify = async (id: string) => {
    setResendingIds((prev) => new Set(prev).add(id));
    setResendErrors((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      await resendSaleDmInquiryNotify(id);
      setTimeout(() => {
        setResendingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        void load();
      }, 3000);
    } catch (e) {
      setResendingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setResendErrors((prev) => ({ ...prev, [id]: e instanceof Error ? e.message : "再送を開始できませんでした" }));
    }
  };

  // focus 対象が読み込み済みなら1回だけスクロールして枠を強調する。1ページ目に無い場合は
  // 何もしない(自動で全件読まない・既存の「さらに読み込む」を利用者に案内するだけ)。
  // 対応済み(折り畳み済み)の行なら先に開いてから次のレンダーでスクロールする。
  useEffect(() => {
    if (!focusId || hasScrolledToFocus.current || items === null) return;
    const target = items.find((i) => i.id === focusId);
    if (!target) return;
    if (target.handleStatus === "done" && !showDone) {
      setShowDone(true);
      return;
    }
    const el = document.getElementById(`inquiry-${focusId}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      hasScrolledToFocus.current = true;
    }
  }, [focusId, items, showDone]);

  const focusPending = focusId !== null && items !== null && !items.some((i) => i.id === focusId) && nextCursor !== null;

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

  // 先頭ページから読み直す(再読み込みと同じ見た目)。
  const refreshButton = (
    <button
      type="button"
      onClick={() => void load()}
      className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
    >
      最新に更新
    </button>
  );

  const renderList = (list: InquiryRow[]) => (
    <ul className="divide-y divide-gray-100 dark:divide-gray-800" data-pii-protected data-pii-surface="owner">
      {list.map((i) => (
        <li
          key={i.id}
          id={`inquiry-${i.id}`}
          className={`py-3${
            mode === "all" && focusId === i.id
              ? " -mx-2 rounded-md bg-indigo-50 px-2 ring-2 ring-indigo-400 dark:bg-indigo-950/30"
              : ""
          }`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-gray-500">{formatJst(i.submittedAt)}</span>
            <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">{i.name}</span>
            {mode === "all" ? (
              <span className="text-xs text-gray-500">
                {i.campaignName ?? "(削除されたキャンペーン)"}
                {i.location ? ` ・ ${i.location}` : ""}
                {i.propertyTypeLabel ? `(${i.propertyTypeLabel})` : ""}
              </span>
            ) : (
              <span className="text-xs text-gray-500">宛先: {recipientName(i.draftId)}</span>
            )}
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
          {i.notifyStatus === "failed" && (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-950/40 dark:text-red-300">
                {resendingIds.has(i.id) ? "通知を送り直しています" : "通知できていません"}
              </span>
              {/* 送信中もボタンは残す(disabled だけ切り替える)。押した直後にボタンごと消すと、
                  クリック直後にフォーカスが失われる(fix round 1・Minor #2)。 */}
              <button
                type="button"
                onClick={() => void resendNotify(i.id)}
                disabled={resendingIds.has(i.id)}
                className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                再送
              </button>
            </div>
          )}
          {resendErrors[i.id] && (
            <p className="mt-1 text-xs text-red-600" role="alert">
              {resendErrors[i.id]}
            </p>
          )}
          {i.contactHidden ? (
            <div className="mt-1 text-xs text-gray-700 dark:text-gray-300">
              <p className="text-gray-500">連絡先を表示する権限がありません</p>
              {i.emailHidden ? (
                <p className="text-gray-400">メール: 表示する権限がありません</p>
              ) : (
                i.email && <p className="break-all">メール: {i.email}</p>
              )}
            </div>
          ) : (
            <dl className="mt-1 grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-0.5 text-xs text-gray-700 dark:text-gray-300">
              <dt className="text-gray-500">電話</dt><dd>{i.phone}</dd>
              {i.emailHidden ? (
                <><dt className="text-gray-500">メール</dt><dd className="text-gray-400">表示する権限がありません</dd></>
              ) : (
                i.email && (<><dt className="text-gray-500">メール</dt><dd className="break-all">{i.email}</dd></>)
              )}
              {i.contactPref && (<><dt className="text-gray-500">希望の連絡方法</dt><dd>{PREF_LABEL[i.contactPref] ?? i.contactPref}</dd></>)}
              {i.freeTextHidden ? (
                <dd className="col-span-2 text-gray-400">時間帯・要望・メモ: 表示する権限がありません</dd>
              ) : (
                <>
                  {i.contactTime && (<><dt className="text-gray-500">時間帯</dt><dd>{i.contactTime}</dd></>)}
                  {i.message && (<><dt className="text-gray-500">要望</dt><dd className="whitespace-pre-wrap">{i.message}</dd></>)}
                </>
              )}
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

      {/* 通知先が誰も居ない(=通知メールが常に失敗する)ときの案内。横断モードにしか
          notifyRecipientCount が無いので、こちらだけに出す(campaign モードには出さない)。 */}
      {mode === "all" && notifyRecipientCount === 0 && (
        <p className="mb-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300">
          通知先が未設定です。管理者に、利用者一覧の「通知」から設定を依頼してください。
        </p>
      )}

      {focusPending && (
        <p className="mb-2 text-xs text-indigo-700 dark:text-indigo-400">
          お知らせの対象の申込はまだ表示されていません。下の「さらに読み込む」で表示できます。
        </p>
      )}

      <section>
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <h3 className="text-xs font-semibold text-gray-700 dark:text-gray-200">
            対応が必要{counts !== null ? ` ${counts.active}件` : ""}
          </h3>
          {openCount > 0 && <span className="text-xs text-gray-500">表示中の未対応 {openCount}件</span>}
        </div>
        {activeUnloaded && nextCursor !== null && (
          <p className="mb-1 text-xs text-amber-700 dark:text-amber-400">
            まだ読み込んでいない古い申込にも対応が必要なものがあります。下の「さらに読み込む」で表示します。
          </p>
        )}
        {/* 最後のページまで読んだのに足りない=一覧を開いた後に届いた新しい申込(先頭ページより前に並ぶ)。 */}
        {activeUnloaded && nextCursor === null && (
          <p className="mb-1 flex flex-wrap items-center gap-2 text-xs text-amber-700 dark:text-amber-400">
            <span>新しい申込が届いています。</span>
            {refreshButton}
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
              {doneUnloaded && nextCursor !== null && (
                <p className="mt-1 text-xs text-gray-500">古い対応済みの申込は「さらに読み込む」で表示します。</p>
              )}
              {doneUnloaded && nextCursor === null && (
                <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                  <span>一覧を開いた後に状態が変わった申込があります。</span>
                  {refreshButton}
                </p>
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
