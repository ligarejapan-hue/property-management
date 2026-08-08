"use client";

import { useState } from "react";
import {
  useRegistryPreflight,
  RegistryPreflightWarningLines,
} from "@/components/properties/registry-preflight-warnings";
import { MapPinned, Loader2 } from "lucide-react";
import {
  searchRegistryCandidates,
  obtainRegistryByCandidate,
  apiErrorCode,
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
  /**
   * capabilities.registryPurchase(段階②・2026-08-01)。**有料取得の専用オプトイン**
   * (REGISTRY_FETCH_PURCHASE_ENABLED)が立っているか。false のとき検索(無料)は使えるが
   * 取得ボタンは準備中表示にする(@codex #345 P1: 無料検索の校正だけで課金操作を露出させない。
   * server 側も 501 で enforce)。
   */
  purchaseEnabled: boolean;
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
  // 利用者が自分で中止した (@codex #357 P2)。失敗ではないので "error" と分ける。
  | "cancelled"
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
  purchaseEnabled,
  onComplete,
}: RegistryLocationSearchButtonProps) {
  const [state, setState] = useState<State>("idle");
  const [candidates, setCandidates] = useState<RegistrySearchCandidate[]>([]);
  const [notSearchableReason, setNotSearchableReason] = useState<string | null>(null);
  const [selected, setSelected] = useState<RegistrySearchCandidate | null>(null);
  // 請求種別（所有者事項=既定・安い方 / 全部事項=高い方）。取得の確認画面で選ぶ。
  const [certificateType, setCertificateType] = useState<"owner" | "all">("owner");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // 実況パネル用の参照 (client 発行・非PII)。検索のたびに発行し直す。
  // HTTP 本番でも動く safeRandomId を使う (crypto.randomUUID 禁止)。
  const [liveRef, setLiveRef] = useState<string | null>(null);
  // 課金直前(取得確認)に事前確認(取得済み/添付あり/所有者あり)を表示する(発注者要望 2026-08-08)。
  const preflight = useRegistryPreflight([propertyId], state === "confirmObtain");

  // 非 admin には導線自体を出さない（サーバ側でも 403 で二重防御）。
  if (!canAutoFetch) return null;

  const providerDisabled = !providerConfigured;

  const reset = () => {
    setState("idle");
    setCandidates([]);
    setNotSearchableReason(null);
    setSelected(null);
    setErrorMsg(null);
    // 実況パネルも閉じる (server 側のスクショは TTL で自動消滅)。
    setLiveRef(null);
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
      // ⚠**自分で押した中止を「失敗」として出さない**(@codex #357 P2)。
      // 中止は 409 で返るが、通信の失敗と同じ経路を通ると赤いエラー表示になり、
      // 「止めたのに何か問題が起きた」と誤解させる。課金が無いことも伝わらない。
      if (apiErrorCode(e) === "REGISTRY_SEARCH_CANCELLED") {
        setErrorMsg(e instanceof Error ? e.message : null);
        setState("cancelled");
        return;
      }
      setErrorMsg(e instanceof Error ? e.message : "所在検索に失敗しました");
      setState("error");
    }
  };

  // 段階②(2026-07-31): 候補(地番)の有料取得。server 側が候補をキャッシュから再解決し、
  // 二重課金台帳→直列化→請求→PDF→物件添付まで行う。confirmed:true は api-client が付ける。
  const runObtain = async () => {
    if (!selected) return;
    setState("obtaining");
    setErrorMsg(null);
    try {
      // 成功レスポンス本文は参照しない（非 PII だが UI に持ち込まない）。取得結果は onComplete →
      // 物件再取得で既存の権限ガード付きタブに反映する。
      await obtainRegistryByCandidate(
        propertyId,
        selected.candidateRef,
        certificateType,
      );
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

      {state === "cancelled" && (
        <div className="flex flex-col gap-1 text-[11px]">
          <p className="text-gray-600 dark:text-gray-300" role="status">
            {errorMsg ?? "取得を中止しました。課金は発生していません。"}
          </p>
          <button type="button" onClick={reset} className="w-fit text-indigo-600 dark:text-indigo-400 hover:underline">
            閉じる
          </button>
        </div>
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

      {/* 実況パネル: 検索実行中の自動操作をスクショ紙芝居で中継する。
          検索完了 (results/error) 後も維持し、最後の画面を見返せるようにする
          (@codex P2: searching 限定だと POST 完了と同時に unmount され「(完了)」
          表示も 3 分の見返しも実際には見えない)。「閉じる」(reset) で消える。
          server 側のスクショは TTL で自動消滅する。 */}
      {liveRef &&
        (state === "searching" ||
          state === "results" ||
          // 中止のときも残す (@codex #357 P2)。どこまで進んで止まったかを
          // 本人が確かめられないと「本当に止まったのか」が分からない。
          state === "cancelled" ||
          state === "error") && (
          <RegistryLivePanel
            propertyId={propertyId}
            liveRef={liveRef}
            searchSettled={state !== "searching"}
          />
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
              {/* 段階②(2026-07-31): 候補を選んで有料の請求→PDF取得まで実行できる。
                  ⚠有料取得は専用オプトイン(purchaseEnabled)が立つまで準備中表示(@codex #345 P1)。 */}
              <p className="text-[11px] text-amber-700 dark:text-amber-400">
                {purchaseEnabled
                  ? "取得は有料です（謄本1通ごとに登記情報提供サービスの利用料がかかります）。"
                  : "候補からの謄本取得（有料）は現在準備中です。"}
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
                      disabled={!purchaseEnabled}
                      title={
                        purchaseEnabled ? undefined : "有料取得は準備中です"
                      }
                      onClick={() => {
                        if (!purchaseEnabled) return;
                        setSelected(c);
                        setState("confirmObtain");
                      }}
                      className={
                        purchaseEnabled
                          ? "shrink-0 rounded bg-indigo-600 px-2 py-1 font-medium text-white hover:bg-indigo-700"
                          : "shrink-0 rounded bg-gray-300 dark:bg-gray-700 px-2 py-1 font-medium text-gray-500 dark:text-gray-400 cursor-not-allowed"
                      }
                    >
                      取得
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
          <RegistryPreflightWarningLines state={preflight} propertyId={propertyId} />
          <p className="truncate text-indigo-700 dark:text-indigo-300">{selected.address ?? "（所在不明）"}</p>
          <p className="truncate text-indigo-700 dark:text-indigo-300">
            {[
              selected.lotNumber && `地番 ${selected.lotNumber}`,
              selected.buildingNumber && `家屋番号 ${selected.buildingNumber}`,
            ]
              .filter(Boolean)
              .join(" / ")}
          </p>
          <fieldset className="mt-1 flex flex-col gap-1 rounded border border-indigo-200 dark:border-indigo-500/30 p-1.5">
            <legend className="px-1 text-indigo-800 dark:text-indigo-300">取得する種類</legend>
            <label className="flex items-center gap-1.5 text-indigo-700 dark:text-indigo-300">
              <input
                type="radio"
                name="certificateType"
                checked={certificateType === "owner"}
                onChange={() => setCertificateType("owner")}
              />
              所有者事項（所有者の確認向け・料金が安い）
            </label>
            <label className="flex items-center gap-1.5 text-indigo-700 dark:text-indigo-300">
              <input
                type="radio"
                name="certificateType"
                checked={certificateType === "all"}
                onChange={() => setCertificateType("all")}
              />
              全部事項（権利関係まで・料金が高い）
            </label>
          </fieldset>
          <p className="text-indigo-700 dark:text-indigo-300">
            取得すると謄本1通分の利用料が発生します（
            {certificateType === "all" ? "全部事項・料金が高い方" : "所有者事項"}
            ）。取得後は物件に自動で添付されます。
            {certificateType === "all" && (
              <span className="mt-0.5 block text-[11px] text-indigo-600 dark:text-indigo-400">
                ※全部事項は過去の所有者も載るため、所有者一覧への自動反映は行わず、PDFの添付のみになります。
              </span>
            )}
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
