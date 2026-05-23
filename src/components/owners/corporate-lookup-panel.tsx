"use client";

// 法人番号 lookup preview パネル（Phase B/C）。
//
// 仕様:
// - 「法人情報を検索」ボタン押下で POST /api/owners/[id]/corporate-lookup を叩く
// - 13桁正規化できない / lookup capability 無効時はボタン disabled
// - 検索結果は preview のみ。Owner 行への書込は「反映」操作（Phase C）でのみ実行
// - Phase C: チェックボックスで反映対象を選び、apply API を呼び出す
//   サーバ側で再 lookup + expectedRecord 比較 + optimistic lock + ChangeLog/AuditLog
// - 廃止法人は confirm ダイアログを挟む
//
// raw XML / API レスポンス本文を画面外に持ち出すことはしない。
// 検索結果は React state のみで保持し、自動保存・自動 lookup はしない。

import { useState } from "react";
import { AlertTriangle, Search, Loader2, CheckCircle2 } from "lucide-react";
import {
  lookupOwnerCorporateNumber,
  applyOwnerCorporate,
  type CorporateLookupApiResponse,
} from "@/lib/api-client";
import { normalizeCorporateNumber } from "@/lib/corporate-number";

interface CorporateLookupPanelProps {
  ownerId: string;
  /** 入力中の法人番号（form.corporateNumber）。正規化前でよい。 */
  rawCorporateNumber: string;
  /** lookup capability（env 未設定なら false）。UI 上は判定不能なので props で渡す。
   *  未指定時は true 扱い（=server-side で 503 が返ったらエラー表示）。 */
  configured?: boolean;
  /** 編集権限がない場合は描画自体しない（呼び出し側で制御） */
  disabledReason?: string | null;
  /** Phase C: 反映に必要な Owner.version。未取得時は反映ボタンを表示しない。 */
  ownerVersion?: number;
  /** Phase C: 各フィールドの編集権限。チェックボックス活性化判定に使う。 */
  fieldEditable?: {
    name: boolean;
    address: boolean;
    zip: boolean;
    corporateNumber: boolean;
  };
  /** Phase C: 反映成功時に親側で owner を再フェッチさせる。 */
  onApplied?: () => void | Promise<void>;
}

type ApplyTarget = "name" | "address" | "zip" | "corporateNumber";

export default function CorporateLookupPanel({
  ownerId,
  rawCorporateNumber,
  configured = true,
  disabledReason = null,
  ownerVersion,
  fieldEditable,
  onApplied,
}: CorporateLookupPanelProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CorporateLookupApiResponse["lookup"] | null>(null);
  // この result / error が「どの 13桁正規化値」に対するものか。
  // 現在の入力値と一致しなくなったら preview / error を出さない（古い検索結果が
  // 別の入力値に対して表示されないことを保証）。
  const [searchedFor, setSearchedFor] = useState<string | null>(null);

  // Phase C 用: 反映対象チェックボックス・apply 進行状態
  const [applyTargets, setApplyTargets] = useState<Record<ApplyTarget, boolean>>({
    name: false,
    address: false,
    zip: false,
    corporateNumber: false,
  });
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);

  const normalized = normalizeCorporateNumber(rawCorporateNumber);
  const canSearch = !!normalized && !loading && configured && !disabledReason;

  // 検索結果と現在の入力が一致している場合のみ表示する。
  const showResult = result !== null && searchedFor !== null && searchedFor === normalized;
  const showError = error !== null && searchedFor !== null && searchedFor === normalized;

  const handleSearch = async () => {
    if (!normalized) {
      setError("法人番号は13桁の数字で入力してください");
      setSearchedFor(normalized);
      setResult(null);
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    setApplied(false);
    setApplyError(null);
    setApplyTargets({ name: false, address: false, zip: false, corporateNumber: false });
    const searchTarget = normalized;
    setSearchedFor(searchTarget);
    try {
      const res = await lookupOwnerCorporateNumber(ownerId, searchTarget);
      setResult(res.lookup);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "検索に失敗しました";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  // Phase C: 反映ボタン押下
  const handleApply = async () => {
    if (!showResult || !result || !result.found || !result.record) return;
    if (typeof ownerVersion !== "number") {
      setApplyError("バージョン情報が取得できていません。画面を再読み込みしてください。");
      return;
    }
    if (
      !applyTargets.name &&
      !applyTargets.address &&
      !applyTargets.zip &&
      !applyTargets.corporateNumber
    ) {
      setApplyError("反映対象を1つ以上選択してください。");
      return;
    }
    if (result.isClosed) {
      const confirmed = window.confirm(
        "この法人は廃止されています。それでも反映を実行しますか？",
      );
      if (!confirmed) return;
    }
    setApplying(true);
    setApplyError(null);
    try {
      await applyOwnerCorporate(ownerId, {
        corporateNumber: result.record.corporateNumber,
        version: ownerVersion,
        apply: applyTargets,
        expectedRecord: {
          corporateNumber: result.record.corporateNumber,
          name: result.record.name,
          address: result.record.address,
          postCode: result.record.postCode,
          updateDate: result.record.updateDate,
        },
        allowClosed: result.isClosed ? true : undefined,
      });
      setApplied(true);
      if (onApplied) {
        await onApplied();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "反映に失敗しました";
      if (msg.includes("FETCH_STALE") || msg.includes("プレビュー")) {
        setApplyError(
          "プレビュー後に法人情報が更新されています。検索し直してください。",
        );
      } else if (msg.includes("CONFLICT") || msg.includes("先に更新")) {
        setApplyError(
          "他のユーザーが先に更新しました。画面を再読み込みしてください。",
        );
      } else if (msg.includes("CLOSED_NOT_ALLOWED")) {
        setApplyError("廃止法人のため反映できません。");
      } else if (msg.includes("NOT_CONFIGURED")) {
        setApplyError("法人番号APIが設定されていません。");
      } else if (msg.includes("UPSTREAM_ERROR") || msg.includes("RATE_LIMITED")) {
        setApplyError("国税庁APIへの再アクセスに失敗しました。時間をおいて再試行してください。");
      } else {
        setApplyError(msg);
      }
    } finally {
      setApplying(false);
    }
  };

  const toggleTarget = (key: ApplyTarget) => {
    setApplyTargets((s) => ({ ...s, [key]: !s[key] }));
    setApplied(false);
    setApplyError(null);
  };

  // Phase C 反映ボタンを描画するための前提
  const canApplyAny =
    !!fieldEditable &&
    (fieldEditable.name ||
      fieldEditable.address ||
      fieldEditable.zip ||
      fieldEditable.corporateNumber);
  const anySelected =
    applyTargets.name ||
    applyTargets.address ||
    applyTargets.zip ||
    applyTargets.corporateNumber;
  const applyButtonEnabled =
    !applying &&
    !applied &&
    typeof ownerVersion === "number" &&
    canApplyAny &&
    anySelected;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleSearch}
          disabled={!canSearch}
          aria-label="法人情報を検索"
          className="inline-flex items-center gap-1.5 rounded-md border border-blue-300 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-50 disabled:text-gray-400"
        >
          {loading ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              検索中...
            </>
          ) : (
            <>
              <Search className="h-3 w-3" />
              法人情報を検索
            </>
          )}
        </button>
        {!configured && (
          <span className="text-xs text-gray-500">
            法人番号API未設定（管理者に env 設定を依頼してください）
          </span>
        )}
        {disabledReason && (
          <span className="text-xs text-gray-500">{disabledReason}</span>
        )}
      </div>

      {showError && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>{error}</div>
        </div>
      )}

      {showResult && result && !result.found && (
        <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700">
          該当する法人が見つかりませんでした（法人番号: {searchedFor}）
        </div>
      )}

      {showResult && result && result.found && result.record && (
        <div
          data-testid="corporate-lookup-preview"
          className="space-y-2 rounded-md border border-blue-200 bg-blue-50/40 px-3 py-3 text-xs text-gray-800"
        >
          <div className="flex items-center gap-2">
            <span className="font-semibold text-gray-700">国税庁データ</span>
            {result.isClosed && (
              <span className="rounded-full border border-red-300 bg-red-100 px-2 py-0.5 text-[10px] font-bold text-red-700">
                廃止法人
              </span>
            )}
            <span className="ml-auto text-[10px] text-gray-500">
              取得: {result.fetchedAt.slice(0, 10)} / {result.source}
            </span>
          </div>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 md:grid-cols-2">
            <PreviewField label="法人番号" value={result.record.corporateNumber} mono />
            <PreviewField label="更新年月日" value={result.record.updateDate} mono />
            <div className="md:col-span-2">
              <PreviewField label="会社名" value={result.record.name} />
            </div>
            {result.record.furigana && (
              <div className="md:col-span-2">
                <PreviewField label="フリガナ" value={result.record.furigana} />
              </div>
            )}
            {result.record.postCode && (
              <PreviewField label="郵便番号" value={result.record.postCode} mono />
            )}
            <div className="md:col-span-2">
              <PreviewField label="所在地" value={result.record.address} />
            </div>
            {result.isClosed && result.closeDate && (
              <PreviewField label="廃止年月日" value={result.closeDate} mono />
            )}
          </dl>

          {/* Phase C: 反映対象選択 + 反映ボタン */}
          <div className="space-y-2 border-t border-blue-100 pt-2">
            {applied ? (
              <div className="flex items-center gap-1.5 rounded-md border border-green-200 bg-green-50 px-2.5 py-1.5 text-[11px] text-green-700">
                <CheckCircle2 className="h-3.5 w-3.5" />
                <span>所有者情報に反映しました</span>
              </div>
            ) : (
              <>
                <div className="text-[11px] font-medium text-gray-700">
                  反映対象を選択
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-700">
                  <ApplyCheckbox
                    label="会社名 → 所有者名"
                    checked={applyTargets.name}
                    editable={!!fieldEditable?.name}
                    onChange={() => toggleTarget("name")}
                  />
                  <ApplyCheckbox
                    label="所在地 → 現住所"
                    checked={applyTargets.address}
                    editable={!!fieldEditable?.address}
                    onChange={() => toggleTarget("address")}
                  />
                  <ApplyCheckbox
                    label="郵便番号"
                    checked={applyTargets.zip}
                    editable={!!fieldEditable?.zip && !!result.record.postCode}
                    onChange={() => toggleTarget("zip")}
                  />
                  <ApplyCheckbox
                    label="法人番号"
                    checked={applyTargets.corporateNumber}
                    editable={!!fieldEditable?.corporateNumber}
                    onChange={() => toggleTarget("corporateNumber")}
                  />
                </div>

                {applyError && (
                  <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    <div>{applyError}</div>
                  </div>
                )}

                <button
                  type="button"
                  onClick={handleApply}
                  disabled={!applyButtonEnabled}
                  className="inline-flex items-center gap-1.5 rounded-md border border-blue-400 bg-blue-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-300"
                >
                  {applying ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" />
                      反映中...
                    </>
                  ) : (
                    "選択した項目を所有者に反映"
                  )}
                </button>
                {typeof ownerVersion !== "number" && (
                  <p className="text-[10px] text-gray-500">
                    所有者バージョンが取得できていないため反映できません
                  </p>
                )}
                {!canApplyAny && fieldEditable && (
                  <p className="text-[10px] text-gray-500">
                    反映に必要な編集権限がありません
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function PreviewField({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-[10px] font-medium uppercase tracking-wider text-gray-500">{label}</dt>
      <dd className={mono ? "font-mono text-gray-900" : "text-gray-900"}>{value ?? "-"}</dd>
    </div>
  );
}

function ApplyCheckbox({
  label,
  checked,
  editable,
  onChange,
}: {
  label: string;
  checked: boolean;
  editable: boolean;
  onChange: () => void;
}) {
  return (
    <label
      className={`inline-flex items-center gap-1 ${
        editable ? "cursor-pointer" : "cursor-not-allowed text-gray-400"
      }`}
      title={editable ? undefined : "編集権限がないか反映可能な値がありません"}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={!editable}
        onChange={onChange}
        className="h-3 w-3 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
      />
      <span>{label}</span>
    </label>
  );
}
