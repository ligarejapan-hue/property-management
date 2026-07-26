"use client";

import { useState } from "react";
import { MapPinned, Loader2 } from "lucide-react";
import {
  searchRegistryCandidates,
  obtainRegistryByCandidate,
  type RegistrySearchCandidate,
} from "@/lib/api-client";
import RegistryLivePanel from "@/components/properties/registry-live-panel";
import { safeRandomId } from "@/lib/random-id";

interface RegistryLocationSearchButtonProps {
  propertyId: string;
  /** registry:auto_fetch 権限。無ければ何も描画しない（非 admin には非表示・server 側でも 403）。 */
  canAutoFetch: boolean;
  /** /api/me/permissions の capabilities.registryAutoFetch。本番 provider が設定済みか。 */
  providerConfigured: boolean;
  /** 取得成功時に親へ通知（物件を再取得し registryStatus 等を反映する）。 */
  onComplete: () => void;
}

type State =
  | "idle"
  | "confirmSearch"
  | "searching"
  | "results"
  | "confirmObtain"
  | "obtaining"
  | "done"
  | "error";

// 謄本「所在検索」導線（PR-2b-3）。番号無し物件を所在/地番/家屋番号で候補検索し、候補を選んで取得する。
//  - 非 admin（registry:auto_fetch 無し）には何も描画しない。
//  - provider 未設定（providerConfigured=false）の現状は disabled + 理由文のみ（本番は 501 fail-closed）。
//  - 検索・取得とも有料になり得るため、実行前に明示確認（confirmed）を出してから POST する（cond①）。
//  - 候補（所在/地番/家屋番号）は認可ユーザー向けに表示するのみ。console/log には出さない（cond②）。
//    不動産番号は応答に含まれない（cond③: 取得時に server 側で candidateRef を再解決）。
//  - 501/409/502 等の非 2xx は成功扱いしない。所有者 PII は一切表示・参照しない。
export default function RegistryLocationSearchButton({
  propertyId,
  canAutoFetch,
  providerConfigured,
  onComplete,
}: RegistryLocationSearchButtonProps) {
  const [state, setState] = useState<State>("idle");
  const [candidates, setCandidates] = useState<RegistrySearchCandidate[]>([]);
  const [notSearchableReason, setNotSearchableReason] = useState<string | null>(null);
  const [selected, setSelected] = useState<RegistrySearchCandidate | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // 実況パネル用の参照 (client 発行・非PII)。検索のたびに発行し直す。
  // HTTP 本番でも動く safeRandomId を使う (crypto.randomUUID 禁止)。
  const [liveRef, setLiveRef] = useState<string | null>(null);

  // 非 admin には導線自体を出さない（サーバ側でも 403 で二重防御）。
  if (!canAutoFetch) return null;

  const providerDisabled = !providerConfigured;

  const reset = () => {
    setState("idle");
    setCandidates([]);
    setNotSearchableReason(null);
    setSelected(null);
    setErrorMsg(null);
  };

  const reasonText = (reason: string): string =>
    reason === "has_real_estate_number"
      ? "この物件は既に不動産番号があります。通常の「謄本を自動取得」をご利用ください。"
      : reason === "insufficient_location"
        ? "所在（住所）が未登録のため検索できません。物件情報に所在を登録してください。"
        : "この物件は所在検索の対象外です。";

  const runSearch = async () => {
    setState("searching");
    setErrorMsg(null);
    // 実況パネルの参照を発行して検索 POST に同封する。実行中の自動操作を
    // 本人がスクショ紙芝居で追える (サーバー側はメモリ内 TTL・完了後破棄)。
    const ref = safeRandomId();
    setLiveRef(ref);
    try {
      const res = await searchRegistryCandidates(propertyId, ref);
      if (res.searchable) {
        setCandidates(res.candidates);
        setNotSearchableReason(res.candidates.length === 0 ? "no_candidates" : null);
      } else {
        setCandidates([]);
        setNotSearchableReason(res.reason);
      }
      setState("results");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "所在検索に失敗しました");
      setState("error");
    }
  };

  // 段階①では取得ボタンを「準備中」で disabled にしており、この経路は起動されない。
  // 取得(有料の請求→PDF)は段階②で実サイトの地番ベース請求フローとして実装し、ここを差し替える。
  const runObtain = async () => {
    if (!selected) return;
    setState("obtaining");
    setErrorMsg(null);
    try {
      // 成功レスポンス本文は参照しない（非 PII だが UI に持ち込まない）。取得結果は onComplete →
      // 物件再取得で既存の権限ガード付きタブに反映する。
      await obtainRegistryByCandidate(propertyId, selected.candidateRef);
      setState("done");
      onComplete();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "謄本の取得に失敗しました");
      setState("error");
    }
  };

  const showButton = state === "idle" || state === "done";

  return (
    <div className="mb-4 flex flex-col gap-1">
      {showButton && (
        <button
          type="button"
          onClick={() => {
            if (providerDisabled) return;
            reset();
            setState("confirmSearch");
          }}
          disabled={providerDisabled}
          className={
            "flex w-fit items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-white " +
            "bg-indigo-600 hover:bg-indigo-700 " +
            "disabled:cursor-not-allowed disabled:opacity-60"
          }
        >
          <MapPinned className="h-3.5 w-3.5" />
          所在で謄本を検索
        </button>
      )}

      {providerDisabled && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400">
          謄本取得プロバイダが未設定のため現在利用できません。
        </p>
      )}

      {state === "done" && (
        <p className="text-[11px] text-green-600 dark:text-green-400">謄本を取得しました。</p>
      )}

      {state === "error" && errorMsg && (
        <div className="flex flex-col gap-1 text-[11px]">
          <p className="text-red-600 dark:text-red-400" role="alert">{errorMsg}</p>
          <button type="button" onClick={reset} className="w-fit text-indigo-600 dark:text-indigo-400 hover:underline">
            閉じる
          </button>
        </div>
      )}

      {state === "confirmSearch" && (
        <div className="flex flex-col gap-1 rounded border border-indigo-200 dark:border-indigo-500/30 bg-indigo-50 dark:bg-indigo-500/15 p-2 text-xs">
          <p className="font-medium text-indigo-800 dark:text-indigo-300">所在で謄本候補を検索しますか？</p>
          <p className="text-indigo-700 dark:text-indigo-300">
            登記情報の検索は有料処理になり得ます。実行には明示的な確認が必要です。
          </p>
          <div className="mt-1 flex gap-1">
            <button type="button" onClick={runSearch} className="rounded bg-indigo-600 px-2 py-1 font-medium text-white hover:bg-indigo-700">
              検索する
            </button>
            <button type="button" onClick={reset} className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800">
              キャンセル
            </button>
          </div>
        </div>
      )}

      {(state === "searching" || state === "obtaining") && (
        <span className="flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400">
          <Loader2 className="h-3 w-3 animate-spin" />
          {state === "searching" ? "検索中..." : "取得中..."}
        </span>
      )}

      {/* 実況パネル: 検索実行中の自動操作をスクショ紙芝居で中継する。 */}
      {state === "searching" && liveRef && (
        <RegistryLivePanel propertyId={propertyId} liveRef={liveRef} />
      )}

      {state === "results" && (
        <div className="flex flex-col gap-1.5 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-2 text-xs">
          {notSearchableReason ? (
            <p className="text-gray-600 dark:text-gray-300">
              {notSearchableReason === "no_candidates"
                ? "該当する謄本候補が見つかりませんでした。"
                : reasonText(notSearchableReason)}
            </p>
          ) : (
            <>
              <p className="font-medium text-gray-700 dark:text-gray-200">
                候補（{candidates.length}件）が見つかりました
              </p>
              {/* 段階①: 候補一覧の表示まで。実取得(有料の請求→PDF)は段階②で対応=ボタンは準備中。 */}
              <p className="text-[11px] text-amber-700 dark:text-amber-400">
                候補からの謄本取得は現在準備中です（近日対応）。
              </p>
              <ul className="flex flex-col gap-1">
                {candidates.map((c) => (
                  <li
                    key={c.candidateRef}
                    className="flex items-center justify-between gap-2 rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 px-2 py-1"
                  >
                    <span className="min-w-0 text-gray-700 dark:text-gray-200">
                      <span className="block truncate">{c.address ?? "（所在不明）"}</span>
                      <span className="block text-[10px] text-gray-500 dark:text-gray-400">
                        {[c.lotNumber && `地番 ${c.lotNumber}`, c.buildingNumber && `家屋番号 ${c.buildingNumber}`]
                          .filter(Boolean)
                          .join(" / ") || "（地番・家屋番号なし）"}
                      </span>
                    </span>
                    <button
                      type="button"
                      disabled
                      title="謄本取得は準備中です"
                      className="shrink-0 rounded bg-gray-300 dark:bg-gray-700 px-2 py-1 font-medium text-gray-500 dark:text-gray-400 cursor-not-allowed"
                    >
                      取得（準備中）
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <button type="button" onClick={reset} className="w-fit text-gray-500 dark:text-gray-400 hover:underline">
            閉じる
          </button>
        </div>
      )}

      {state === "confirmObtain" && selected && (
        <div className="flex flex-col gap-1 rounded border border-indigo-200 dark:border-indigo-500/30 bg-indigo-50 dark:bg-indigo-500/15 p-2 text-xs">
          <p className="font-medium text-indigo-800 dark:text-indigo-300">この候補で謄本を取得しますか？</p>
          <p className="truncate text-indigo-700 dark:text-indigo-300">{selected.address ?? "（所在不明）"}</p>
          <p className="text-indigo-700 dark:text-indigo-300">
            登記情報の取得は有料処理になり得ます。実行には明示的な確認が必要です。
          </p>
          <div className="mt-1 flex gap-1">
            <button type="button" onClick={runObtain} className="rounded bg-indigo-600 px-2 py-1 font-medium text-white hover:bg-indigo-700">
              取得する
            </button>
            <button
              type="button"
              onClick={() => {
                setSelected(null);
                setState("results");
              }}
              className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              戻る
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
