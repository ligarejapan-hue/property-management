"use client";

import { useState } from "react";
import { FileSearch, Loader2 } from "lucide-react";
import {
  useRegistryPreflight,
  RegistryPreflightWarningLines,
} from "@/components/properties/registry-preflight-warnings";

interface RegistryAutoFetchButtonProps {
  propertyId: string;
  registryStatus: string;
  /** registry:auto_fetch 権限。無ければ何も描画しない（非 admin には非表示）。 */
  canAutoFetch: boolean;
  /** /api/me/permissions の capabilities.registryAutoFetch。本番 provider が設定済みか。 */
  providerConfigured: boolean;
  /** 取得成功時に親へ通知（物件を再取得し registryStatus 等を反映する）。 */
  onComplete: () => void;
}

type State = "idle" | "confirming" | "submitting" | "done" | "error";

// 謄本「自動取得」導線（PR5）。専用ボタンとして実装し、ActionBar の ACTIONS[] には載せない。
//  - 非 admin（registry:auto_fetch 無し）には何も描画しない。
//  - admin かつ provider 未設定（providerConfigured=false）の現状は disabled + 理由文だけを表示し、
//    確認フローへ進めない（本番 provider 実装まではこの状態）。
//  - provider 設定済みのときだけ確認（有料・明示確認）へ進み、submit 時のみ課金確認フラグを POST する。
//  - 501（PROVIDER_NOT_CONFIGURED）/ 409（ALREADY_RUNNING）等の非 2xx は成功扱いしない。
//  - 所有者氏名 / 住所などの個人情報（PII）は一切表示・ログしない（成功レスポンス本文も参照しない）。
export default function RegistryAutoFetchButton({
  propertyId,
  registryStatus,
  canAutoFetch,
  providerConfigured,
  onComplete,
}: RegistryAutoFetchButtonProps) {
  const [state, setState] = useState<State>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // 確認パネルを開いたときだけ事前確認(取得済み/添付あり/所有者あり)を取得する。
  const preflight = useRegistryPreflight([propertyId], state === "confirming");

  // 非 admin には導線自体を出さない（サーバ側でも 403 で二重防御）。
  if (!canAutoFetch) return null;

  const providerDisabled = !providerConfigured;
  const alreadyObtained = registryStatus === "obtained";

  const handleClick = () => {
    // provider 未設定中は実行不可（ボタンは disabled だが念のためガード）。
    if (providerDisabled) return;
    setErrorMsg(null);
    setState("confirming");
  };

  const handleCancel = () => {
    setState("idle");
  };

  const handleConfirm = async () => {
    setState("submitting");
    setErrorMsg(null);
    try {
      // submit 経路でのみ課金確認フラグを送る。body はこの確認のみ。
      const res = await fetch(
        `/api/properties/${propertyId}/registry/auto-fetch`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirmed: true }),
        },
      );
      // 非 2xx（501 未設定 / 409 実行中 等）は成功扱いしない。エラー本文は
      // { error: { message, code } } の非 PII メッセージのみ参照する。
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error?.message ?? "謄本の自動取得に失敗しました");
      }
      // 成功レスポンス本文は参照しない（所有者 PII を UI に持ち込まない）。
      // 取得結果は onComplete → 物件再取得で既存の権限ガード付きタブに反映する。
      setState("done");
      onComplete();
    } catch (e) {
      setErrorMsg(
        e instanceof Error ? e.message : "謄本の自動取得に失敗しました",
      );
      setState("error");
    }
  };

  const showButton =
    state === "idle" || state === "error" || state === "done";

  return (
    <div className="mb-4 flex flex-col gap-1">
      {showButton && (
        <button
          type="button"
          onClick={handleClick}
          disabled={providerDisabled}
          className={
            "flex w-fit items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-white " +
            "bg-indigo-600 hover:bg-indigo-700 " +
            "disabled:cursor-not-allowed disabled:opacity-60"
          }
        >
          <FileSearch className="h-3.5 w-3.5" />
          謄本を自動取得
        </button>
      )}

      {providerDisabled && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400">
          謄本自動取得プロバイダが未設定のため現在実行できません。
        </p>
      )}

      {state === "done" && (
        <p className="text-[11px] text-green-600 dark:text-green-400">謄本を取得しました。</p>
      )}

      {state === "error" && errorMsg && (
        <p className="text-[11px] text-red-600 dark:text-red-400">{errorMsg}</p>
      )}

      {state === "confirming" && (
        <div className="flex flex-col gap-1 rounded border border-indigo-200 dark:border-indigo-500/30 bg-indigo-50 dark:bg-indigo-500/15 p-2 text-xs">
          <p className="font-medium text-indigo-800 dark:text-indigo-300">謄本を自動取得しますか？</p>
          <p className="text-indigo-700 dark:text-indigo-300">
            登記情報の取得は有料処理になり得ます。実行には明示的な確認が必要です。
          </p>
          {alreadyObtained && (
            <p className="text-amber-700 dark:text-amber-400">
              この物件は既に取得済みです。再取得すると最新の謄本で上書きされます。
            </p>
          )}
          {/* 事前確認(サーバ判定): 謄本PDF添付あり/所有者入力あり(発注者要望 2026-08-08)。
              取得済み行は、上の registryStatus(props)由来の警告が出ているときだけ抑制する。
              props が古い(別タブで取得済みになった等)場合はサーバ判定の警告を出す(#365 R2)。 */}
          <RegistryPreflightWarningLines
            state={preflight}
            propertyId={propertyId}
            showObtained={!alreadyObtained}
          />
          <div className="mt-1 flex gap-1">
            <button
              type="button"
              onClick={handleConfirm}
              disabled={preflight.pending}
              title={preflight.pending ? "事前確認中です" : undefined}
              className="rounded bg-indigo-600 px-2 py-1 font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {preflight.pending ? "確認中..." : "実行"}
            </button>
            <button
              type="button"
              onClick={handleCancel}
              className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              キャンセル
            </button>
          </div>
        </div>
      )}

      {state === "submitting" && (
        <span className="flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400">
          <Loader2 className="h-3 w-3 animate-spin" />
          取得中...
        </span>
      )}
    </div>
  );
}
