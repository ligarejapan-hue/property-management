"use client";

import { useState, useEffect } from "react";
import {
  fetchRegistryPreflight,
  type RegistryPreflightFlags,
} from "@/lib/api-client";
import type { RegistryTarget } from "@/lib/registry-fetch/registry-target";

// 謄本取得の事前警告(発注者要望 2026-08-08)。
// 「既に取得済み/謄本PDF添付あり/所有者入力済み」の物件へ課金する前に気づけるようにする。
// 判定はサーバ(POST /api/registry-fetch/preflight)に一元化し、単発ボタン・所在検索・
// 一括モーダルの3入口が同じ結果を表示する。警告のみで実行はブロックしない
// (意図した再取得は可能なまま)。事前確認が失敗したときは黙って消さず、その旨を出す。

export interface RegistryPreflightState {
  flagsById: Map<string, RegistryPreflightFlags>;
  /** ⚠「何を取りに行くか(土地/建物)」。**買う対象そのもの**であって参考情報ではない。 */
  targetsById: Map<string, RegistryTarget>;
  failed: boolean;
  /** 事前確認が未完了(実行ボタンはこの間 disabled にする=#365 R1: 警告を見る前に課金させない)。 */
  pending: boolean;
  /**
   * ⚠分類が読めていない。true の間は実行ボタンを**押せないままにする**(fail closed)。
   *
   * `failed` と別に持つ理由: 取得済み・所有者ありのような**参考情報**の失敗は
   * 従来どおり「注意書きを出したうえで実行できる」ままにしたい。一方
   * 「土地と建物のどちらを買うのか」は分からないまま実行すると**候補1件で
   * 自動購入まで進む**ので、こちらだけ止める(設計 §3.1.1)。
   */
  targetsUnavailable: boolean;
}

/** active が true になったタイミングで preflight を1回取得する。 */
export function useRegistryPreflight(
  propertyIds: string[],
  active: boolean,
  /**
   * 取り直しの合図。⚠ポップアップで地番を保存すると分類が変わるので、
   * この値を変えて取り直す(対象も active も変わらないため、これが無いと古い分類のまま)。
   */
  reloadToken: number = 0,
): RegistryPreflightState {
  const [flagsById, setFlagsById] = useState<
    Map<string, RegistryPreflightFlags>
  >(new Map());
  const [targetsById, setTargetsById] = useState<Map<string, RegistryTarget>>(
    new Map(),
  );
  const [failed, setFailed] = useState(false);
  // ⚠既定は true(取れていない)。開いた直後から実行させない。
  const [targetsUnavailable, setTargetsUnavailable] = useState(true);
  // 完了済みの対象集合キー。pending はここから導出する(effect 内の同期 setState を
  // 使わずに「確認が済むまで実行を止める」を実現する=#365 R1)。
  const [settledKey, setSettledKey] = useState<string | null>(null);
  // useEffect の依存を安定させる(選択順に依存しないようソートして結合)。
  const idsKey = `${reloadToken}|${[...propertyIds].sort().join(",")}`;

  // ⚠effect 内の同期 setState は lint 規約(react-hooks/set-state-in-effect)で禁止。
  // 状態更新はすべて fetch の then/catch(非同期)内で行う。
  useEffect(() => {
    if (!active || idsKey.length === 0) return;
    let cancelled = false;
    // 再オープン時は前回の確定を無効化する(#365 R3: 閉じている間に所有者追加・取得済み化が
    // あり得るため、キャッシュ表示のまま即実行させない)。同期 setState は lint 規約で
    // 禁止のため microtask で行う(実クリックまでには必ず反映される)。
    Promise.resolve().then(() => {
      if (cancelled) return;
      setSettledKey(null);
      setFailed(false);
      // ⚠取り直しの間は分類を「読めていない」に戻す(古い分類で実行させない)。
      setTargetsUnavailable(true);
    });
    fetchRegistryPreflight(idsKey.split(","))
      .then((res) => {
        if (cancelled) return;
        setFailed(false);
        setFlagsById(new Map(res.data.map((f) => [f.propertyId, f])));
        setTargetsById(new Map(res.data.map((f) => [f.propertyId, f.target])));
        setTargetsUnavailable(false);
        setSettledKey(idsKey);
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
        setFlagsById(new Map());
        setTargetsById(new Map());
        // ⚠分類だけは「確定」させない。参考情報の失敗と違い、分からないまま
        //   実行すると候補1件で自動購入まで進む(設計 §3.1.1・fail closed)。
        setTargetsUnavailable(true);
        setSettledKey(idsKey); // 失敗も「確定」= failed の注意書きを見せた上で実行可能にする
      });
    return () => {
      cancelled = true;
    };
  }, [active, idsKey]);

  return {
    flagsById,
    targetsById,
    failed,
    pending: active && propertyIds.length > 0 && settledKey !== idsKey,
    // 閉じているときは止める理由が無い(実行ボタン自体が出ない)。
    targetsUnavailable: active && targetsUnavailable,
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
      <p>
        番号がある・所在が不足しているものは自動で対象外になりますが、それ以外は
        取得(課金)の対象になります。ご確認のうえ実行してください。
      </p>
    </div>
  );
}

/**
 * 「何を取りに行くか（土地／建物）」を見せる。
 *
 * ⚠**見せるだけで止めない**（種別との食い違いは警告・発注者判断 2026-08-12）。
 * 止めるのは「分類そのものが読めていない」ときだけで、それは呼び出し側が
 * `targetsUnavailable` でボタンを disabled にすることで行う。
 */
export function RegistryTargetNote({
  state,
  propertyId,
}: {
  state: RegistryPreflightState;
  propertyId: string;
}) {
  if (state.targetsUnavailable) {
    return (
      <p className="text-[11px] text-amber-700 dark:text-amber-300">
        何を取りに行くか確認できませんでした。もう一度お試しください。
      </p>
    );
  }
  const target = state.targetsById.get(propertyId);
  if (!target) return null;
  return (
    <div className="text-[11px] text-gray-700 dark:text-gray-300">
      <span className="font-medium">
        {target.kind === "building"
          ? "建物の登記を取得します"
          : target.kind === "land"
            ? "土地の登記を取得します"
            : target.kind === "number"
              ? // ⚠番号がある物件は所在で探す経路の対象外。地番を尋ねてはいけない。
                "不動産番号があるため、所在検索の対象外です（通常の「謄本を自動取得」をご利用ください）"
              : "取得する登記を決められません（地番か家屋番号が必要です）"}
      </span>
      {/* ⚠食い違いは見せるだけ。確認したうえで実行できる。 */}
      {target.mismatchWarning && (
        <span className="mt-0.5 block text-amber-700 dark:text-amber-300">
          ⚠ {target.mismatchWarning}
        </span>
      )}
    </div>
  );
}
