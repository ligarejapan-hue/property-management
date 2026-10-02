"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  apiErrorCode,
  fetchPropertyAgentInquiries,
  putPropertyAdPermission,
  type AdMediumKey,
  type PropertyAgentInquiries,
} from "@/lib/api-client";
import { AD_MEDIA_ORDER, AD_MEDIUM_LABEL, AD_VALUE_MARK, isAmbiguousSaveError } from "@/lib/agent-inquiry/desk-form";
import { AD_VALUE_WORD, nextAdValue, timelineKindLabel, timelineWhen } from "@/lib/agent-inquiry/main-view";
import { notifyInquiryChanged, onInquiryChanged } from "@/lib/agent-inquiry/desk-sync";
import { AD_TONE } from "@/components/agent-inquiry/ad-permission-chips";
import { Button } from "@/components/ui/button";

/** 広告の可否の保存に失敗したときの文言。 */
export function adSaveErrorMessage(e: unknown): string {
  const code = apiErrorCode(e);
  if (code === "VERSION_CONFLICT") return "他の人が先に変えました。今の表示が最新です。変えるときはもう一度押してください。";
  if (code === "FORBIDDEN") return "広告の可否を変える権限がありません。";
  // 通信が切れた・中継の時間切れは、サーバー側では変わっていることがある=失敗と言い切らない。
  if (isAmbiguousSaveError(e)) return "変更できたか分かりません(通信が切れました)。今の表示が最新です。";
  return e instanceof Error && e.message ? e.message : "変更できませんでした。";
}

/** 物件画面の反響欄の見た目(設計 §2.3)。件数 → 広告の可否 → 時系列(新しい順)。 */
export function PropertyInquiryView({
  data,
  canEditAds,
  savingMedium,
  message,
  onToggleAd,
  onReload,
}: {
  data: PropertyAgentInquiries;
  canEditAds: boolean;
  savingMedium: AdMediumKey | null;
  message: string | null;
  onToggleAd: (m: AdMediumKey) => void;
  onReload: () => void;
}) {
  const c = data.counts;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-700 dark:text-gray-300">
          <b>反響 {c.total}件</b>
          <span>案内 {c.guided}</span>
          <span>下見 {c.preview}</span>
          <span>資料請求 {c.materialRequest}</span>
          <span>広告の許可 {c.adPermission}</span>
        </p>
        <span className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={onReload}>
            読み直す
          </Button>
          {/* 名前付きの窓に開く(同じ窓があればそこへ)。noopener を付けると毎回新しい窓になる。 */}
          <a href="/inquiry-desk" target="pm-inquiry-desk" className="text-sm text-indigo-600 underline dark:text-indigo-400">
            反響の受付を開く ↗
          </a>
        </span>
      </div>

      <section aria-label="広告の可否">
        <h3 className="mb-1 text-sm font-semibold text-gray-900 dark:text-gray-100">広告の可否</h3>
        <ul className="grid grid-cols-2 gap-1 text-xs sm:grid-cols-3">
          {AD_MEDIA_ORDER.map((m) => {
            const v = data.adPermissions[m] ?? null;
            const tone = AD_TONE[v ?? "none"];
            const mark = v ? AD_VALUE_MARK[v] : "—";
            if (!canEditAds) {
              return (
                <li key={m} className={`flex justify-between rounded px-2 py-1.5 ${tone}`}>
                  <span>{AD_MEDIUM_LABEL[m]}</span>
                  <b>{mark}</b>
                </li>
              );
            }
            return (
              <li key={m}>
                <button
                  type="button"
                  data-ad-medium={m}
                  // 保存中は6つとも止める=連打で古い値(from)のまま2回目を送らない。
                  disabled={savingMedium != null}
                  onClick={() => onToggleAd(m)}
                  aria-label={`${AD_MEDIUM_LABEL[m]}: ${AD_VALUE_WORD[v ?? "none"]}。押すと ${AD_VALUE_WORD[nextAdValue(v) ?? "none"]} に変わります`}
                  className={`flex w-full justify-between rounded px-2 py-1.5 ring-1 ring-inset ring-black/5 hover:ring-indigo-400 disabled:cursor-not-allowed disabled:opacity-60 dark:ring-white/10 ${tone}`}
                >
                  <span>{AD_MEDIUM_LABEL[m]}</span>
                  <b>{savingMedium === m ? "…" : mark}</b>
                </button>
              </li>
            );
          })}
        </ul>
        <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
          ○=可 ×=不可 △=担当者に確認 —=未設定
          {canEditAds && "。押すたびに ○→×→△→未設定 と切り替わり、その場で保存されます。"}
        </p>
        {message && (
          <p role="alert" className="mt-1 text-sm text-rose-600 dark:text-rose-400">
            {message}
          </p>
        )}
      </section>

      <section aria-label="反響の時系列">
        <h3 className="mb-1 text-sm font-semibold text-gray-900 dark:text-gray-100">これまでの反響(新しい順)</h3>
        {data.timeline.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">この物件への反響はまだありません。</p>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {data.timeline.map((e) => (
              <li key={e.key} className={`py-2 text-sm${e.canceled ? " opacity-50" : ""}`}>
                <span className="mr-2 text-xs text-gray-500 dark:text-gray-400">{timelineWhen(e)}</span>
                <span className="mr-2 rounded bg-gray-100 px-1.5 py-0.5 text-xs dark:bg-gray-800">{timelineKindLabel(e)}</span>
                {e.canceled && <span className="mr-2 text-xs text-gray-500 dark:text-gray-400">取り消し</span>}
                <span className="font-medium">{e.agentName}</span>
                {e.contactName && <span>{`(${e.contactName}様)`}</span>}
                {e.attendantName && <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">{`立ち会い:${e.attendantName}`}</span>}
                {e.resultNote && <p className="mt-0.5 whitespace-pre-wrap text-xs text-gray-600 dark:text-gray-300">{e.resultNote}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * 物件画面の「反響」タブ。読む=物件の閲覧権限、広告の可否を変える=物件の編集権限(canWrite は親が渡す)。
 * ⚠ここでは権限表を読まない(API が物件の規則で 403 を返す)。
 */
export default function AgentInquiryTab({ propertyId, canWrite }: { propertyId: string; canWrite: boolean }) {
  const [data, setData] = useState<PropertyAgentInquiries | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savingMedium, setSavingMedium] = useState<AdMediumKey | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // 読み込みの世代。新しい読み込みを始めたら、古い読み込みの結果は捨てる(順番が入れ替わっても古い値で上書きしない)。
  const genRef = useRef(0);
  const savingRef = useRef(false);
  // 変更を権限なしで断られた(開いている間に編集権限・担当を外された)。親の権限が更新されるのを待たず、
  // このタブではボタンを出さない(開き直すと親の権限で決め直す)。
  const [writeDenied, setWriteDenied] = useState(false);

  const load = useCallback(async () => {
    const gen = ++genRef.current;
    try {
      const d = await fetchPropertyAgentInquiries(propertyId);
      if (genRef.current !== gen) return;
      setData(d);
      setLoadError(null);
    } catch (e) {
      if (genRef.current !== gen) return;
      const forbidden = apiErrorCode(e) === "FORBIDDEN";
      // 開いたまま権限・担当を外されたら、読んであった中身も消す(古い表示を残さない)。
      if (forbidden) setData(null);
      setLoadError(forbidden ? "この物件の反響を見る権限がありません。" : "反響を読み込めませんでした。");
    }
  }, [propertyId]);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    // 受付の窓で登録・変更されたら読み直す。窓に戻ってきたときも読み直す(合図が使えない環境の保険)。
    const off = onInquiryChanged(() => void load());
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      clearTimeout(first);
      off();
      window.removeEventListener("focus", onFocus);
      genRef.current += 1;
    };
  }, [load]);

  const toggle = async (medium: AdMediumKey) => {
    if (!data || savingRef.current) return;
    const from = data.adPermissions[medium] ?? null;
    savingRef.current = true;
    setSavingMedium(medium);
    setMessage(null);
    try {
      const r = await putPropertyAdPermission(propertyId, { medium, value: nextAdValue(from), from });
      setData((d) => (d ? { ...d, adPermissions: r.adPermissions } : d));
      notifyInquiryChanged();
    } catch (e) {
      if (apiErrorCode(e) === "FORBIDDEN") setWriteDenied(true);
      setMessage(adSaveErrorMessage(e));
    }
    // 成功でも失敗でも、保存の後に始めた読み込みで今の値に揃える(保存中に始まった古い読み込みは世代で捨てる)。
    await load();
    savingRef.current = false;
    setSavingMedium(null);
  };

  if (loadError && !data) {
    return (
      <div className="text-sm">
        <p className="mb-2 text-rose-600 dark:text-rose-400">{loadError}</p>
        <Button variant="secondary" size="sm" onClick={() => void load()}>
          もう一度読む
        </Button>
      </div>
    );
  }
  if (!data) return <p className="text-sm text-gray-500 dark:text-gray-400">読み込み中…</p>;
  return (
    <>
      {loadError && (
        <p role="alert" className="mb-2 text-sm text-rose-600 dark:text-rose-400">
          {loadError}(下の表示は最新ではないかもしれません)
        </p>
      )}
      <PropertyInquiryView
        data={data}
        canEditAds={canWrite && !writeDenied}
        savingMedium={savingMedium}
        message={message}
        onToggleAd={(m) => void toggle(m)}
        onReload={() => void load()}
      />
    </>
  );
}
