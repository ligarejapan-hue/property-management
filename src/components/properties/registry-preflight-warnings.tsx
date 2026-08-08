"use client";

import { useState, useEffect } from "react";
import {
  fetchRegistryPreflight,
  type RegistryPreflightFlags,
} from "@/lib/api-client";

// 謄本取得の事前警告(発注者要望 2026-08-08)。
// 「既に取得済み/謄本PDF添付あり/所有者入力済み」の物件へ課金する前に気づけるようにする。
// 判定はサーバ(POST /api/registry-fetch/preflight)に一元化し、単発ボタン・所在検索・
// 一括モーダルの3入口が同じ結果を表示する。警告のみで実行はブロックしない
// (意図した再取得は可能なまま)。事前確認が失敗したときは黙って消さず、その旨を出す。

export interface RegistryPreflightState {
  flagsById: Map<string, RegistryPreflightFlags>;
  failed: boolean;
  /** 事前確認が未完了(実行ボタンはこの間 disabled にする=#365 R1: 警告を見る前に課金させない)。 */
  pending: boolean;
}

/** active が true になったタイミングで preflight を1回取得する。 */
export function useRegistryPreflight(
  propertyIds: string[],
  active: boolean,
): RegistryPreflightState {
  const [flagsById, setFlagsById] = useState<
    Map<string, RegistryPreflightFlags>
  >(new Map());
  const [failed, setFailed] = useState(false);
  // 完了済みの対象集合キー。pending はここから導出する(effect 内の同期 setState を
  // 使わずに「確認が済むまで実行を止める」を実現する=#365 R1)。
  const [settledKey, setSettledKey] = useState<string | null>(null);
  // useEffect の依存を安定させる(選択順に依存しないようソートして結合)。
  const idsKey = [...propertyIds].sort().join(",");

  // ⚠effect 内の同期 setState は lint 規約(react-hooks/set-state-in-effect)で禁止。
  // 状態更新はすべて fetch の then/catch(非同期)内で行う。
  useEffect(() => {
    if (!active || idsKey.length === 0) return;
    let cancelled = false;
    fetchRegistryPreflight(idsKey.split(","))
      .then((res) => {
        if (cancelled) return;
        setFailed(false);
        setFlagsById(new Map(res.data.map((f) => [f.propertyId, f])));
        setSettledKey(idsKey);
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
        setFlagsById(new Map());
        setSettledKey(idsKey); // 失敗も「確定」= failed の注意書きを見せた上で実行可能にする
      });
    return () => {
      cancelled = true;
    };
  }, [active, idsKey]);

  return {
    flagsById,
    failed,
    pending: active && idsKey.length > 0 && settledKey !== idsKey,
  };
}

const LINE_CLASS = "text-amber-700 dark:text-amber-400";

/** 単発(1物件)用の警告行。showObtained=false は呼び出し元が独自の取得済み警告を持つ場合。 */
export function RegistryPreflightWarningLines({
  state,
  propertyId,
  showObtained = true,
}: {
  state: RegistryPreflightState;
  propertyId: string;
  showObtained?: boolean;
}) {
  if (state.failed) {
    return (
      <p className="text-[11px] text-gray-500 dark:text-gray-400">
        (取得済みかどうかの事前確認に失敗しました。取得済み・所有者入力済みの可能性にご注意ください)
      </p>
    );
  }
  const flags = state.flagsById.get(propertyId);
  if (!flags) return null;
  return (
    <>
      {showObtained && flags.registryObtained && (
        <p className={LINE_CLASS}>
          ⚠この物件は登記状況が「取得済」です。再取得すると追加の利用料が発生します。
        </p>
      )}
      {flags.hasRegistryAttachment && (
        <p className={LINE_CLASS}>
          ⚠この物件には既に謄本PDFが添付されています(添付ファイルタブで確認できます)。
        </p>
      )}
      {flags.hasOwners && (
        <p className={LINE_CLASS}>
          ⚠この物件には既に所有者情報が入力されています。
        </p>
      )}
    </>
  );
}

/** 一括(複数物件)用の件数警告。該当ゼロなら何も出さない。 */
export function RegistryPreflightCountLines({
  state,
}: {
  state: RegistryPreflightState;
}) {
  if (state.failed) {
    return (
      <p className="text-xs text-gray-500 dark:text-gray-400">
        (取得済みかどうかの事前確認に失敗しました。取得済み・所有者入力済みの物件が含まれる可能性にご注意ください)
      </p>
    );
  }
  const flags = [...state.flagsById.values()];
  const obtained = flags.filter((f) => f.registryObtained).length;
  const attached = flags.filter((f) => f.hasRegistryAttachment).length;
  const withOwners = flags.filter((f) => f.hasOwners).length;
  if (obtained === 0 && attached === 0 && withOwners === 0) return null;
  return (
    <div className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
      <p className="font-medium">⚠選択した物件に、既に情報があるものが含まれています:</p>
      <ul className="ml-4 list-disc">
        {obtained > 0 && <li>登記状況が「取得済」: {obtained}件</li>}
        {attached > 0 && <li>謄本PDFの添付あり: {attached}件</li>}
        {withOwners > 0 && <li>所有者の入力あり: {withOwners}件</li>}
      </ul>
      <p>これらの物件も取得(課金)の対象になります。よろしければそのまま実行してください。</p>
    </div>
  );
}
