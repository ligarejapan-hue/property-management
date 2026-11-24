"use client";

import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import { mergeBlockReasonLabel } from "@/lib/owner-merge-reason-labels";

// blockReason enum → 日本語ラベル（「この1人に全部まとめる」と共有・owner-merge-reason-labels.ts）
function reasonLabel(r: string): string {
  return mergeBlockReasonLabel(r);
}

// 同じ所有者と言えた経路（enum → 画面の言葉）。
const MATCHED_BY_LABELS: Record<string, string> = {
  name_address: "氏名住所一致",
  corporate_number: "法人番号一致",
  corporate_name: "法人名一致",
};

// 法人のペアで引き継ぐ・記録に残す項目（項目名だけ。値は API も返さない）。
const HANDOVER_FIELD_LABELS: Record<string, string> = {
  address: "登記上の住所",
  zip: "郵便番号",
  phone: "電話",
  corporateNumber: "法人番号",
  companyRegistryNumber: "会社法人等番号",
  email: "メール",
  nameKana: "フリガナ",
  name: "名前の書き方",
};

function fieldList(fields: string[] | undefined): string {
  return (fields ?? []).map((f) => HANDOVER_FIELD_LABELS[f] ?? f).join("・");
}

interface MergePreviewSummary {
  propertyOwnersToMove: number;
  propertyOwnersToDeduplicate: number;
  sourceOwnerMemoCount: number;
  sourceOwnerMemoWithPropertyCount: number;
  sourceChangeLogCount: number;
  sourceImportJobRowCount: number;
  sourceVersion: number | null;
  masterVersion: number | null;
  normalizeKeyMatches: boolean;
  /** 同じ所有者と言えた経路（2026-11-24〜。古い応答には無い）。 */
  matchedBy?: string | null;
  /** 法人のペアで master へ写す項目名。 */
  corporateHandoverFields?: string[];
  /** 法人のペアで写さず master の変更履歴に残す項目名。 */
  corporateKeptFields?: string[];
}

interface MergePreviewResponse {
  eligible: boolean;
  blockReasons: string[];
  masterId: string;
  sourceId: string;
  summary: MergePreviewSummary;
}

interface MergeExecuteResult {
  propertyOwnersMoved: number;
  propertyOwnersDeduplicated: number;
  ownerMemosMoved: number;
  sourceArchived: boolean;
}

interface OwnerMergePreviewButtonProps {
  masterId: string;
  sourceId: string;
  /** 表示専用ラベル（master / source の識別子）。PII は出さない。 */
  masterLabel: string;
  sourceLabel: string;
  /** execute 成功後に候補一覧を再取得するための callback。 */
  onExecuted?: () => void;
}

type State = "idle" | "loading" | "done" | "error";

// execute UI の状態。2 段階確認: idle → confirm1 → confirm2 → executing → executed | execute_error
type ExecuteState =
  | "idle"
  | "confirm1"
  | "confirm2"
  | "executing"
  | "executed"
  | "execute_error";

export function OwnerMergePreviewButton({
  masterId,
  sourceId,
  masterLabel,
  sourceLabel,
  onExecuted,
}: OwnerMergePreviewButtonProps) {
  const [state, setState] = useState<State>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [result, setResult] = useState<MergePreviewResponse | null>(null);

  // execute 用の独立 state（preview state と切り分け）
  const [executeState, setExecuteState] = useState<ExecuteState>("idle");
  const [executeErrorMsg, setExecuteErrorMsg] = useState<string | null>(null);
  const [executeBlockReasons, setExecuteBlockReasons] = useState<string[]>([]);
  const [executeResult, setExecuteResult] = useState<MergeExecuteResult | null>(
    null,
  );

  // masterId / sourceId が変わったら古い preview / execute 結果を破棄する。
  // 別ペア（例: A/B → A/C）の結果が、変更後のラベル A/C と乖離したまま
  // 表示され続けて operator の判断を誤らせるのを防ぐ。
  useEffect(() => {
    setState("idle");
    setErrorMsg(null);
    setResult(null);
    setExecuteState("idle");
    setExecuteErrorMsg(null);
    setExecuteBlockReasons([]);
    setExecuteResult(null);
  }, [masterId, sourceId]);

  const reset = () => {
    setState("idle");
    setErrorMsg(null);
    setResult(null);
    setExecuteState("idle");
    setExecuteErrorMsg(null);
    setExecuteBlockReasons([]);
    setExecuteResult(null);
  };

  const resetExecute = () => {
    setExecuteState("idle");
    setExecuteErrorMsg(null);
    setExecuteBlockReasons([]);
  };

  const handleExecute = async () => {
    if (!result || !result.eligible) return;
    setExecuteState("executing");
    setExecuteErrorMsg(null);
    setExecuteBlockReasons([]);
    try {
      const res = await fetch("/api/admin/owners/correction/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          masterId,
          sourceId,
          masterVersion: result.summary.masterVersion,
          sourceVersion: result.summary.sourceVersion,
          dryRun: false,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        const reasons = Array.isArray(j?.error?.blockReasons)
          ? (j.error.blockReasons as string[])
          : [];
        setExecuteBlockReasons(reasons);
        setExecuteErrorMsg(j?.error?.message ?? "統合に失敗しました");
        setExecuteState("execute_error");
        return;
      }
      setExecuteResult((j?.result ?? null) as MergeExecuteResult | null);
      setExecuteState("executed");
      // 成功後に候補一覧を再取得（archived source が一覧から消える）
      onExecuted?.();
    } catch (e) {
      setExecuteResult(null);
      setExecuteErrorMsg(
        e instanceof Error ? e.message : "統合に失敗しました",
      );
      setExecuteState("execute_error");
    }
  };

  const handleClick = async () => {
    setState("loading");
    setErrorMsg(null);
    setResult(null);
    try {
      const res = await fetch(
        "/api/admin/owners/correction/merge-preview",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ masterId, sourceId }),
        },
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        const reasons = Array.isArray(j?.error?.blockReasons)
          ? (j.error.blockReasons as string[])
          : [];
        setResult({
          eligible: false,
          blockReasons: reasons,
          masterId,
          sourceId,
          summary: {
            propertyOwnersToMove: 0,
            propertyOwnersToDeduplicate: 0,
            sourceOwnerMemoCount: 0,
            sourceOwnerMemoWithPropertyCount: 0,
            sourceChangeLogCount: 0,
            sourceImportJobRowCount: 0,
            sourceVersion: null,
            masterVersion: null,
            normalizeKeyMatches: false,
          },
        });
        setErrorMsg(j?.error?.message ?? "プレビューの取得に失敗しました");
        setState("error");
        return;
      }
      setResult(j as MergePreviewResponse);
      setState("done");
    } catch (e) {
      // transport-level failure (network / timeout / CORS / offline)。
      // この経路では JSON body が無いので result は null のまま、
      // errorMsg だけ立てる。UI 側は result の有無に依存しない
      // 独立した通信エラーバナーで表示する。
      setResult(null);
      setErrorMsg(
        e instanceof Error ? e.message : "プレビューの取得に失敗しました",
      );
      setState("error");
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={handleClick} disabled={state === "loading"}>
          {state === "loading" ? "判定中..." : "統合プレビュー"}
        </Button>
        {state !== "idle" && (
          <Button variant="ghost" size="sm" onClick={reset}>
            閉じる
          </Button>
        )}
      </div>

      {state === "loading" && (
        <p className="text-xs text-gray-500 dark:text-gray-400">判定中...</p>
      )}

      {/* 通信失敗（fetch throw / network / offline 等）用の独立エラーバナー。
          result が null のままでもユーザーに失敗が伝わるようにする。
          API が JSON エラーボディを返した HTTP 4xx/5xx ケースは下の result
          ブロックで blockReasons と共に表示する。 */}
      {state === "error" && !result && errorMsg && (
        <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-400/20 dark:bg-red-500/10 dark:text-red-300">
          <p className="font-medium">プレビューの取得に失敗しました</p>
          <p className="mt-0.5 break-words">{errorMsg}</p>
          <p className="mt-1 text-[11px] text-red-500 dark:text-red-300">
            通信状況を確認してもう一度お試しください。
          </p>
        </div>
      )}

      {result && (
        <div
          className={`rounded-md border p-2 text-xs ${
            result.eligible
              ? "border-green-200 bg-green-50 dark:border-green-400/20 dark:bg-green-500/10"
              : "border-red-200 bg-red-50 dark:border-red-400/20 dark:bg-red-500/10"
          }`}
        >
          <p
            className={`mb-1 font-medium ${
              result.eligible ? "text-green-800 dark:text-green-300" : "text-red-800 dark:text-red-300"
            }`}
          >
            {/* ⚠「実行は未実装」と書かれていた名残に注意。execute は
                Phase 2-B-β で実装済み（下に「統合を実行」ボタンが出る）。
                機能側を直したのに文言だけ古いまま残ると、使えるのに
                使われない状態になる（2026-09-06 修正）。 */}
            {result.eligible
              ? "✓ 統合可能"
              : "✗ 統合不可"}
          </p>

          {errorMsg && !result.eligible && (
            <p className="mb-1 text-red-700 dark:text-red-300">{errorMsg}</p>
          )}

          <p className="mb-1 text-gray-600 dark:text-gray-300">
            master: <span className="font-mono">{masterLabel}</span> / source:{" "}
            <span className="font-mono">{sourceLabel}</span>
          </p>

          {/* blockReasons */}
          {result.blockReasons.length > 0 && (
            <ul className="mb-2 list-disc pl-4 text-red-700 dark:text-red-300">
              {result.blockReasons.map((r) => (
                <li key={r}>{reasonLabel(r)}</li>
              ))}
            </ul>
          )}

          {/* summary 件数。PII（owner名 / address / メモ本文）は含めない。 */}
          <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-gray-700 dark:text-gray-200">
            <dt>PropertyOwner 移動予定</dt>
            <dd className="font-mono">{result.summary.propertyOwnersToMove}</dd>
            <dt>PropertyOwner 重複（destination 既存）</dt>
            <dd className="font-mono">
              {result.summary.propertyOwnersToDeduplicate}
            </dd>
            <dt>OwnerMemo（合計）</dt>
            <dd
              className={`font-mono ${
                result.summary.sourceOwnerMemoCount > 0
                  ? "font-bold text-amber-700 dark:text-amber-300"
                  : ""
              }`}
            >
              {result.summary.sourceOwnerMemoCount}
            </dd>
            <dt>うち物件紐付きメモ</dt>
            <dd className="font-mono">
              {result.summary.sourceOwnerMemoWithPropertyCount}
            </dd>
            <dt>source 側 ChangeLog</dt>
            <dd className="font-mono">{result.summary.sourceChangeLogCount}</dd>
            <dt>source 側 ImportJobRow</dt>
            <dd className="font-mono">
              {result.summary.sourceImportJobRowCount}
            </dd>
            <dt>master version</dt>
            <dd className="font-mono">
              {result.summary.masterVersion ?? "—"}
            </dd>
            <dt>source version</dt>
            <dd className="font-mono">
              {result.summary.sourceVersion ?? "—"}
            </dd>
            <dt>同じ所有者の確認</dt>
            <dd className="font-mono">
              {result.summary.normalizeKeyMatches
                ? MATCHED_BY_LABELS[result.summary.matchedBy ?? ""] ?? "yes"
                : "no"}
            </dd>
          </dl>

          {/* 法人のペアだけ: 引き継ぐ項目と記録に残す項目（項目名のみ・値は出さない）。 */}
          {result.summary.matchedBy &&
            ((result.summary.corporateHandoverFields?.length ?? 0) > 0 ||
              (result.summary.corporateKeptFields?.length ?? 0) > 0) && (
              <p className="mt-1 text-gray-600 dark:text-gray-300">
                {(result.summary.corporateHandoverFields?.length ?? 0) > 0 &&
                  `master が空の項目を引き継ぎます: ${fieldList(result.summary.corporateHandoverFields)}。`}
                {(result.summary.corporateKeptFields?.length ?? 0) > 0 &&
                  `値が違う項目は引き継がず、master の変更履歴に残します: ${fieldList(result.summary.corporateKeptFields)}。`}
              </p>
            )}

          {/* execute UI: eligible=true かつ result が現在の master/source pair に
              対応している場合のみ表示。useEffect で pair 変更時に result が
              リセットされるので、暗黙的に「現在の pair に対する preview 結果」
              であることが保証される。 */}
          {result.eligible &&
            result.masterId === masterId &&
            result.sourceId === sourceId &&
            executeState !== "executed" && (
              <div className="mt-3 rounded-md border border-red-300 bg-red-50 p-2 dark:border-red-400/20 dark:bg-red-500/10">
                <p className="mb-1 text-xs font-semibold text-red-800 dark:text-red-300">
                  ⚠ 統合実行はこの操作は元に戻せません
                </p>

                {executeState === "idle" && (
                  <Button variant="danger" size="sm" onClick={() => setExecuteState("confirm1")}>
                    統合を実行
                  </Button>
                )}

                {executeState === "confirm1" && (
                  <div className="flex flex-col gap-1 text-xs text-red-800 dark:text-red-300">
                    <p>
                      master <span className="font-mono">{masterLabel}</span> に
                      source <span className="font-mono">{sourceLabel}</span> を
                      統合します。
                    </p>
                    <p>
                      PropertyOwner 移動 {result.summary.propertyOwnersToMove}件 /
                      重複削除 {result.summary.propertyOwnersToDeduplicate}件 /
                      OwnerMemo 移行 {result.summary.sourceOwnerMemoCount}件
                    </p>
                    <p className="text-red-700 dark:text-red-300">
                      source はアーカイブされ通常検索から除外されます。
                    </p>
                    <div className="mt-1 flex gap-1">
                      <Button variant="danger" size="sm" onClick={() => setExecuteState("confirm2")}>
                        次へ
                      </Button>
                      <Button variant="ghost" size="sm" onClick={resetExecute}>
                        キャンセル
                      </Button>
                    </div>
                  </div>
                )}

                {executeState === "confirm2" && (
                  <div className="flex flex-col gap-1 text-xs text-red-800 dark:text-red-300">
                    <p className="font-semibold">
                      ⚠ この操作は元に戻せません。本当に統合しますか？
                    </p>
                    <div className="mt-1 flex gap-1">
                      <Button variant="danger" size="sm" onClick={handleExecute}>
                        実行する
                      </Button>
                      <Button variant="ghost" size="sm" onClick={resetExecute}>
                        キャンセル
                      </Button>
                    </div>
                  </div>
                )}

                {executeState === "executing" && (
                  <p className="text-xs text-gray-600 dark:text-gray-300">統合中...</p>
                )}

                {executeState === "execute_error" && (
                  <div className="flex flex-col gap-0.5 text-xs text-red-700 dark:text-red-300">
                    {executeErrorMsg && <p>{executeErrorMsg}</p>}
                    {executeBlockReasons.length > 0 && (
                      <ul className="list-disc pl-4">
                        {executeBlockReasons.map((r) => (
                          <li key={r}>{reasonLabel(r)}</li>
                        ))}
                      </ul>
                    )}
                    {/* data-ui=raw: 赤い注意の枠の中の小さな文字リンク */}
                    <button
                      data-ui="raw"
                      type="button"
                      onClick={resetExecute}
                      className="mt-1 self-start text-[11px] text-red-600 underline dark:text-red-300"
                    >
                      閉じる
                    </button>
                  </div>
                )}
              </div>
            )}

          {/* 成功表示（実行完了後の result サマリ）。
              PII を含まず件数のみ表示。 */}
          {executeState === "executed" && executeResult && (
            <div className="mt-3 rounded-md border border-green-300 bg-green-50 p-2 text-xs text-green-800 dark:border-green-400/20 dark:bg-green-500/10 dark:text-green-300">
              <p className="mb-1 font-semibold">
                ✓ 統合が完了しました
              </p>
              <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5">
                <dt>PropertyOwner 移動</dt>
                <dd className="font-mono">
                  {executeResult.propertyOwnersMoved}
                </dd>
                <dt>PropertyOwner 重複削除</dt>
                <dd className="font-mono">
                  {executeResult.propertyOwnersDeduplicated}
                </dd>
                <dt>OwnerMemo 移行</dt>
                <dd className="font-mono">{executeResult.ownerMemosMoved}</dd>
                <dt>source archive</dt>
                <dd className="font-mono">
                  {executeResult.sourceArchived ? "yes" : "no"}
                </dd>
              </dl>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
