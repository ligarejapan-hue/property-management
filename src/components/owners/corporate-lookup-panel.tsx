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
  type CorporateIdentifierKindDTO,
  type CorporateLookupConflictDTO,
} from "@/lib/api-client";
import {
  classifyCorporateIdentifier,
  normalizeCorporateIdentifier,
  calculateCorporateNumberFromCompanyNumber,
} from "@/lib/corporate-number";

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
  // 入力種別 / 解決済み13桁 / conflict 分類（route が server 側で解決した結果）。
  const [meta, setMeta] = useState<{
    inputKind?: CorporateIdentifierKindDTO;
    resolvedCorporateNumber13?: string;
    conflict?: CorporateLookupConflictDTO;
  } | null>(null);
  // この result / error が「どの正規化入力(12/13桁)」に対するものか。
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

  // 12桁(会社法人等番号) / 13桁(法人番号・CD正) を受け付ける。invalid は検索不可。
  const kind = classifyCorporateIdentifier(rawCorporateNumber);
  // 検索キー兼 route 送信値（正規化済み 12/13桁。route が server 側で 13桁に解決）。
  const identifierKey = normalizeCorporateIdentifier(rawCorporateNumber);
  const canSearch =
    kind !== "invalid" && !loading && configured && !disabledReason;
  // 12桁入力時にクライアント側で算出した13桁（事前ヒント表示用。server を正とする）。
  const derived13 =
    kind === "company_corporate_number_12"
      ? calculateCorporateNumberFromCompanyNumber(rawCorporateNumber)
      : null;
  // 入力が非空 だが invalid のときだけ理由を出す（空入力では出さない）。
  const invalidHint =
    rawCorporateNumber.trim() !== "" && kind === "invalid"
      ? "12桁の会社法人等番号、または13桁の法人番号（チェックデジット正）を入力してください"
      : null;

  // 検索結果と現在の入力が一致している場合のみ表示する。
  const showResult =
    result !== null && searchedFor !== null && searchedFor === identifierKey;
  const showError =
    error !== null && searchedFor !== null && searchedFor === identifierKey;

  const handleSearch = async () => {
    if (kind === "invalid" || !identifierKey) {
      setError(
        "12桁の会社法人等番号、または13桁の法人番号（チェックデジット正）を入力してください",
      );
      setSearchedFor(identifierKey);
      setResult(null);
      setMeta(null);
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    setMeta(null);
    setApplied(false);
    setApplyError(null);
    setApplyTargets({ name: false, address: false, zip: false, corporateNumber: false });
    const searchTarget = identifierKey;
    setSearchedFor(searchTarget);
    try {
      // 12桁/13桁いずれもそのまま送り、route 側で 13桁へ解決して lookup する。
      const res = await lookupOwnerCorporateNumber(ownerId, searchTarget);
      setResult(res.lookup);
      setMeta({
        inputKind: res.inputKind,
        resolvedCorporateNumber13: res.resolvedCorporateNumber13,
        conflict: res.conflict,
      });
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
    const record = result.record;
    const closed = result.isClosed;
    // 案2: 12桁で検索した場合、元の会社法人等番号(12桁)を apply に同梱して保存させる
    // (searchedFor は検索時の正規化入力。inputKind=12 のとき 12桁)。
    const companyRegistry12 =
      meta?.inputKind === "company_corporate_number_12"
        ? searchedFor ?? undefined
        : undefined;
    const submit = (acknowledgeConflict?: boolean) =>
      applyOwnerCorporate(ownerId, {
        corporateNumber: record.corporateNumber,
        version: ownerVersion,
        apply: applyTargets,
        expectedRecord: {
          corporateNumber: record.corporateNumber,
          name: record.name,
          address: record.address,
          postCode: record.postCode,
          updateDate: record.updateDate,
        },
        allowClosed: closed ? true : undefined,
        acknowledgeConflict,
        companyRegistryNumber: companyRegistry12,
      });
    setApplying(true);
    setApplyError(null);
    try {
      await submit();
      setApplied(true);
      if (onApplied) {
        await onApplied();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "反映に失敗しました";
      // 「明らかな不一致(conflict)」は確認のうえ acknowledgeConflict=true で再送する
      // （allowClosed と同型）。generic CONFLICT(楽観ロック)より先に判定する
      // ＝CONFLICT_NOT_ACKNOWLEDGED は "CONFLICT" を含むため順序が重要。
      if (
        msg.includes("CONFLICT_NOT_ACKNOWLEDGED") ||
        msg.includes("大きく異なります")
      ) {
        const ok = window.confirm(
          "国税庁の法人情報が既存の所有者情報と大きく異なります。内容を確認のうえ反映しますか？",
        );
        if (!ok) {
          setApplyError("情報の不一致を確認してください（反映を中止しました）。");
          return;
        }
        try {
          await submit(true);
          setApplied(true);
          if (onApplied) {
            await onApplied();
          }
        } catch (err2) {
          setApplyError(
            err2 instanceof Error ? err2.message : "反映に失敗しました",
          );
        }
        return;
      }
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
          className="inline-flex items-center gap-1.5 rounded-md border border-blue-300 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100 dark:border-blue-400/20 dark:bg-blue-500/10 dark:text-blue-300 dark:hover:bg-blue-500/20 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-50 disabled:text-gray-400 dark:disabled:border-gray-700 dark:disabled:bg-gray-800 dark:disabled:text-gray-500"
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
          <span className="text-xs text-gray-500 dark:text-gray-400">
            法人番号API未設定（管理者に env 設定を依頼してください）
          </span>
        )}
        {disabledReason && (
          <span className="text-xs text-gray-500 dark:text-gray-400">{disabledReason}</span>
        )}
      </div>

      {/* 入力種別の事前ヒント（server を正としつつ即時フィードバック）。 */}
      {!disabledReason && configured && derived13 && (
        <p className="text-[11px] text-gray-500 dark:text-gray-400">
          12桁 会社法人等番号 → 法人番号{" "}
          <span className="font-mono">{derived13}</span> を検索します
        </p>
      )}
      {!disabledReason && configured && invalidHint && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">{invalidHint}</p>
      )}

      {showError && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-400/20 dark:bg-red-500/10 dark:text-red-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>{error}</div>
        </div>
      )}

      {showResult && result && !result.found && (
        <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300">
          該当する法人が見つかりませんでした（法人番号:{" "}
          {meta?.resolvedCorporateNumber13 ?? searchedFor}）
        </div>
      )}

      {/* conflict: 国税庁結果と既存所有者情報が明らかに別物のときの事前警告。 */}
      {showResult && result && result.found && meta?.conflict === "conflict" && (
        <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>
            国税庁の法人情報が既存の所有者情報と大きく異なります。別法人の可能性がないか確認のうえ反映してください。
          </div>
        </div>
      )}

      {showResult && result && result.found && result.record && (
        <div
          data-testid="corporate-lookup-preview"
          className="space-y-2 rounded-md border border-blue-200 bg-blue-50/40 px-3 py-3 text-xs text-gray-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-gray-200"
        >
          <div className="flex items-center gap-2">
            <span className="font-semibold text-gray-700 dark:text-gray-200">国税庁データ</span>
            {result.isClosed && (
              <span className="rounded-full border border-red-300 bg-red-100 px-2 py-0.5 text-[10px] font-bold text-red-700">
                廃止法人
              </span>
            )}
            <span className="ml-auto text-[10px] text-gray-500 dark:text-gray-400">
              取得: {result.fetchedAt.slice(0, 10)} / {result.source}
            </span>
          </div>
          {meta?.inputKind && meta.inputKind !== "invalid" && (
            <p className="text-[10px] text-gray-500 dark:text-gray-400">
              入力:{" "}
              {meta.inputKind === "company_corporate_number_12"
                ? "12桁 会社法人等番号"
                : "13桁 法人番号"}
              {meta.inputKind === "company_corporate_number_12" &&
                meta.resolvedCorporateNumber13 && (
                  <>
                    {" "}
                    → 算出した法人番号{" "}
                    <span className="font-mono">
                      {meta.resolvedCorporateNumber13}
                    </span>
                  </>
                )}
            </p>
          )}
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
              <div className="flex items-center gap-1.5 rounded-md border border-green-200 bg-green-50 px-2.5 py-1.5 text-[11px] text-green-700 dark:border-green-400/20 dark:bg-green-500/10 dark:text-green-300">
                <CheckCircle2 className="h-3.5 w-3.5" />
                <span>所有者情報に反映しました</span>
              </div>
            ) : (
              <>
                <div className="text-[11px] font-medium text-gray-700 dark:text-gray-200">
                  反映対象を選択
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-700 dark:text-gray-200">
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

                {/* 案2: 12桁検索で法人番号を反映する場合、元の12桁も会社法人等番号として保存される旨。 */}
                {meta?.inputKind === "company_corporate_number_12" &&
                  applyTargets.corporateNumber &&
                  searchedFor && (
                    <p className="text-[10px] text-gray-500 dark:text-gray-400">
                      会社法人等番号（
                      <span className="font-mono">{searchedFor}</span>
                      ・12桁）も併せて保存されます
                    </p>
                  )}

                {applyError && (
                  <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700 dark:border-red-400/20 dark:bg-red-500/10 dark:text-red-300">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    <div>{applyError}</div>
                  </div>
                )}

                <button
                  type="button"
                  onClick={handleApply}
                  disabled={!applyButtonEnabled}
                  className="inline-flex items-center gap-1.5 rounded-md border border-indigo-400 bg-indigo-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-300 dark:disabled:border-gray-700 dark:disabled:bg-gray-700"
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
                  <p className="text-[10px] text-gray-500 dark:text-gray-400">
                    所有者バージョンが取得できていないため反映できません
                  </p>
                )}
                {!canApplyAny && fieldEditable && (
                  <p className="text-[10px] text-gray-500 dark:text-gray-400">
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
      <dt className="text-[10px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className={mono ? "font-mono text-gray-900 dark:text-gray-100" : "text-gray-900 dark:text-gray-100"}>{value ?? "-"}</dd>
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
        editable ? "cursor-pointer" : "cursor-not-allowed text-gray-400 dark:text-gray-500"
      }`}
      title={editable ? undefined : "編集権限がないか反映可能な値がありません"}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={!editable}
        onChange={onChange}
        className="h-3 w-3 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 disabled:opacity-50 dark:border-gray-700"
      />
      <span>{label}</span>
    </label>
  );
}
