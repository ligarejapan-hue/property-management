"use client";

/**
 * 住所補完の補助 UI（PR2・UI core）。
 *
 * フォーム本体の zip / address 入力は親が所有し、本コンポーネントは「補助操作＋候補表示」だけを担う
 * （propsで現値と onChange を受け取る）。**本 PR ではどのフォームにも組み込まない**＝存在と配線のみ。
 *
 *  - mode="postal": 郵便番号 → 住所（明示ボタン「住所を自動入力」）。
 *  - mode="search": 住所 → 郵便番号候補（入力に応じて debounce 検索＝hook 内 300ms）。
 *  - mode="both":   両方。
 *
 * 上書き方針: 住所欄が空なら zip と住所を同時に自動反映、既存値があれば silent overwrite
 * せず確認し、**確認まで zip も住所も反映しない**（キャンセルで「郵便番号だけ変わる」
 * 不整合を残さない＝Codex P2-C）。郵便番号 lookup の単一候補は自動反映する（Codex P2-D）。
 * 住所検索はユーザー編集で住所が変わった時だけ＝mount 時の既存住所では provider へ
 * 送らない（Codex P2-E）。
 * 取得は hook（api-client wrapper 経由）＝社内 route のみ・APIキーには触れない。
 */
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { AddressLookupCandidate } from "@/lib/address-lookup/types";
import { useAddressLookup } from "@/hooks/use-address-lookup";
import {
  formatCandidateLabel,
  requiresCandidateSelection,
  needsOverwriteConfirm,
  isSingleCandidate,
  planCandidateApplication,
  evaluateAddressSearchEffect,
  type AddressLookupErrorKind,
  type AddressSearchEffectState,
  type CandidateApplication,
} from "@/lib/address-lookup-ui-utils";

export type AddressLookupMode = "postal" | "search" | "both";

/** 分類済みエラー → UI 文言（具体的な原因文や PII は出さない）。 */
const ERROR_MESSAGES: Record<AddressLookupErrorKind, string> = {
  invalid_input: "郵便番号・住所の形式をご確認ください。",
  not_configured: "住所補完は現在利用できません。",
  provider_error:
    "住所補完サービスに接続できませんでした。時間をおいて再度お試しください。",
  unknown: "住所の取得に失敗しました。",
};

export interface AddressLookupControlsProps {
  /** 現在の郵便番号（親が所有）。 */
  zip: string;
  /** 現在の住所（親が所有）。 */
  address: string;
  /** 郵便番号を更新する。 */
  onZipChange: (zip: string) => void;
  /** 住所を更新する。 */
  onAddressChange: (address: string) => void;
  /** 親フォームが編集不可のとき true（権限ゲート等は親側で判定）。 */
  disabled?: boolean;
  mode: AddressLookupMode;
}

const linkBtn =
  "rounded border border-indigo-200 px-2 py-1 font-medium text-indigo-700 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50";

export function AddressLookupControls({
  zip,
  address,
  onZipChange,
  onAddressChange,
  disabled = false,
  mode,
}: AddressLookupControlsProps) {
  const {
    loading,
    error,
    candidates,
    lookupByPostalCode,
    searchByAddress,
    reset,
  } = useAddressLookup();

  // 住所欄へ反映しようとした候補（既存住所があるときは確認のため保留）。
  // 確認確定まで onZipChange / onAddressChange は一切呼ばない（Codex P2-C）。
  const [pendingCandidate, setPendingCandidate] =
    useState<AddressLookupCandidate | null>(null);
  // 郵便番号ボタンで一度でも引いたか（mount 直後・既存値ありで「見つかりません」を出さないため。
  // event handler / 非同期継続でのみ更新＝effect 内 setState を避ける）。
  const [postalAttempted, setPostalAttempted] = useState(false);

  const showPostal = mode === "postal" || mode === "both";
  const showSearch = mode === "search" || mode === "both";

  // 郵便番号 lookup の onSuccess 継続（非同期）から現在の住所を読むための ref。
  // render では読まず、effect / handler / 継続の中だけで使う。
  const addressRef = useRef(address);
  useEffect(() => {
    addressRef.current = address;
  }, [address]);

  // 住所検索ガード: mount 時の既存住所・候補反映で自分が書いた住所では検索しない
  // （Codex P2-E）。effect 内でのみ読み書きする。
  const searchGuardRef = useRef<AddressSearchEffectState>({
    lastSeenAddress: address,
    programmaticAddress: null,
  });

  // 住所 → 郵便番号: ユーザー編集で住所が「変わった」時だけ検索（hook 内で 300ms debounce）。
  // mount 時の既存住所では検索しない＝レコードを開いただけで住所 PII を送らない（P2-E）。
  // disabled 中は検索しない（P2-A）。空になったらリセットして古い候補を消す。
  // effect 内では関数呼び出しのみ（setState しない）。
  useEffect(() => {
    const outcome = evaluateAddressSearchEffect(
      showSearch,
      disabled,
      address,
      searchGuardRef.current,
    );
    searchGuardRef.current = outcome.nextState;
    if (outcome.action === "reset") {
      reset();
      return;
    }
    if (outcome.action === "search") {
      searchByAddress(address);
    }
  }, [address, showSearch, disabled, searchByAddress, reset]);

  // 計画（zip＋住所のペア）を親フォームへ同時反映し、保留・候補状態を片付ける。
  // 自分が書いた住所は次の検索 effect で consume させる（反映による再検索を防ぐ）。
  const applyPlanNow = (plan: CandidateApplication) => {
    searchGuardRef.current = {
      ...searchGuardRef.current,
      programmaticAddress: plan.addressLine,
    };
    if (plan.zip !== null) onZipChange(plan.zip);
    onAddressChange(plan.addressLine);
    setPendingCandidate(null);
    setPostalAttempted(false);
    reset();
  };

  // 候補を採用: 住所欄が空なら zip と住所を同時に即反映。既存住所があれば確認まで
  // どちらも反映しない（キャンセルで「郵便番号だけ変わる」を残さない＝P2-C）。
  const applyCandidate = (candidate: AddressLookupCandidate) => {
    const plan = planCandidateApplication(candidate, address);
    if (plan.mode === "immediate") {
      applyPlanNow(plan);
    } else {
      // silent overwrite せず確認 UI を出す。
      setPendingCandidate(candidate);
    }
  };

  const confirmOverwrite = () => {
    if (pendingCandidate !== null) {
      applyPlanNow(planCandidateApplication(pendingCandidate, address));
    }
  };

  // 郵便番号 → 住所（明示操作）。単一候補は onSuccess（成功かつ最新のときだけ呼ばれる
  // 非同期継続）で自動反映＝空住所ならボタン 1 回で入力が完了する（Codex P2-D）。
  // 既存住所がある場合は単一候補でも上書き確認を出す。
  const handlePostalLookup = () => {
    setPendingCandidate(null);
    setPostalAttempted(true);
    lookupByPostalCode(zip, (received) => {
      if (!isSingleCandidate(received)) return;
      const plan = planCandidateApplication(received[0], addressRef.current);
      if (plan.mode === "immediate") {
        applyPlanNow(plan);
      } else {
        setPendingCandidate(received[0]);
      }
    });
  };

  // 「該当なし」は明示的な郵便番号ボタン操作の後にだけ出す（debounce 検索中の誤表示・
  // mount 直後の誤表示を避ける。検索方向の空は候補リストが出ないことで自明）。
  const showNoResult =
    postalAttempted &&
    !loading &&
    error === null &&
    pendingCandidate === null &&
    candidates.length === 0 &&
    zip.trim() !== "";

  return (
    <div className="space-y-1.5 text-xs">
      {showPostal && (
        <button
          type="button"
          onClick={handlePostalLookup}
          disabled={disabled || loading || zip.trim() === ""}
          className={linkBtn}
        >
          住所を自動入力
        </button>
      )}

      {showSearch && !disabled && (
        <p className="text-gray-400">
          住所を入力すると郵便番号候補を検索します
        </p>
      )}

      {loading && (
        <p className="flex items-center gap-1 text-gray-500">
          <Loader2 className="h-3 w-3 animate-spin" />
          検索中...
        </p>
      )}

      {error && <p className="text-red-600">{ERROR_MESSAGES[error]}</p>}

      {!loading && requiresCandidateSelection(candidates) && (
        <p className="text-gray-500">複数の候補があります。選択してください。</p>
      )}

      {!loading && candidates.length > 0 && (
        <ul className="max-h-40 overflow-y-auto rounded border border-gray-200">
          {candidates.map((candidate, i) => (
            <li
              key={`${candidate.source}-${candidate.postalCode ?? ""}-${i}`}
              className="border-b border-gray-100 last:border-b-0"
            >
              <button
                type="button"
                onClick={() => applyCandidate(candidate)}
                disabled={disabled}
                className="block w-full px-2 py-1 text-left hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {formatCandidateLabel(candidate)}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* 既存住所がある場合の上書き確認（silent overwrite 禁止）。確認確定まで
          郵便番号も住所も親フォームへ反映しない＝キャンセルで不整合を残さない（P2-C）。 */}
      {pendingCandidate !== null && needsOverwriteConfirm(address) && (
        <div className="space-y-1 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-amber-800">
          <p>
            現在の郵便番号・住所を「{formatCandidateLabel(pendingCandidate)}
            」で上書きしますか?
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={confirmOverwrite}
              disabled={disabled}
              className="rounded bg-amber-600 px-2 py-0.5 font-medium text-white hover:bg-amber-700 disabled:opacity-50"
            >
              上書きする
            </button>
            <button
              type="button"
              onClick={() => setPendingCandidate(null)}
              className="rounded border border-gray-300 px-2 py-0.5 text-gray-600 hover:bg-gray-50"
            >
              キャンセル
            </button>
          </div>
        </div>
      )}

      {showNoResult && (
        <p className="text-gray-500">該当する住所が見つかりません。</p>
      )}
    </div>
  );
}
