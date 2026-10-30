"use client";

/**
 * 謄本の有料取得「今月の有料取得 ◯円/50,000円」(2026-10-29 月の上限=5万円)。
 * 1件の取得(所在検索のボタン)・一括取得の確認・一括の進捗画面で共通に使う。
 *
 * ⚠表示は目安。**本物の判定はサーバーが課金の直前に行う**(並行する取得もそこで数える)。
 *   読み込めなかったときはボタンを止めない(サーバーが止める)。
 */
import { useEffect, useState } from "react";
import { fetchRegistryMonthlyUsage } from "@/lib/api-client";
import {
  describeMonthlyUsage,
  monthlyCapBlockedReason,
  type RegistryMonthlyUsage,
} from "@/lib/registry-fetch/monthly-cap";
import type { RegistryCertificateType } from "@/lib/registry-fetch/types";

export interface RegistryMonthlyUsageState {
  /** 読み込めた利用額(まだ/失敗は null)。 */
  usage: RegistryMonthlyUsage | null;
  failed: boolean;
}

/**
 * 利用額を読む。active が false→true になるたびに読み直す
 * (確認の画面を開くたびに最新にする)。
 */
export function useRegistryMonthlyUsage(
  active: boolean,
  reloadToken: number = 0,
): RegistryMonthlyUsageState {
  const [usage, setUsage] = useState<RegistryMonthlyUsage | null>(null);
  const [failed, setFailed] = useState(false);
  // ⚠effect 内の同期 setState は lint 規約(react-hooks/set-state-in-effect)で禁止。
  //   状態更新はすべて then/catch(非同期)の中で行う(useRegistryPreflight と同じ形)。
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    fetchRegistryMonthlyUsage()
      .then((u) => {
        if (cancelled) return;
        setUsage(u);
        setFailed(false);
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [active, reloadToken]);
  return { usage, failed };
}

/** 「今月の有料取得 ◯円/50,000円」と、押せないときの理由。 */
export function RegistryMonthlyUsageLine({
  state,
  certificateType,
}: {
  state: RegistryMonthlyUsageState;
  /** 理由の判定に使う種類(省略=理由を出さない・額だけ)。 */
  certificateType?: RegistryCertificateType;
}) {
  if (!state.usage) {
    return (
      <p className="text-[11px] text-gray-500 dark:text-gray-400">
        {state.failed
          ? "今月の有料取得額を読み込めませんでした（取得の直前にも確認します）。"
          : "今月の有料取得額を確認中..."}
      </p>
    );
  }
  const reason = certificateType
    ? monthlyCapBlockedReason(state.usage, certificateType)
    : null;
  return (
    <div className="text-[11px]">
      <p className="text-gray-600 dark:text-gray-300">
        {describeMonthlyUsage(state.usage.usedYen, state.usage.capYen)}
      </p>
      {reason && (
        <p role="alert" className="font-medium text-red-700 dark:text-red-400">
          {reason}
        </p>
      )}
    </div>
  );
}
