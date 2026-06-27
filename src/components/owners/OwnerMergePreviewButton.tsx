"use client";

import { useEffect, useState } from "react";

// blockReason enum → 日本語ラベル（owner-merge.ts の OwnerMergeBlockReason と一致）
const MERGE_BLOCK_REASON_LABELS: Record<string, string> = {
  same_owner_id: "master と source が同一です",
  master_not_found: "master 所有者が存在しません",
  source_not_found: "source 所有者が存在しません",
  master_archived: "master 所有者がアーカイブ済みです",
  source_archived: "source 所有者がアーカイブ済みです",
  source_has_changelog: "source に手動編集履歴があります",
  source_has_note: "source に備考が入力されています",
  source_has_external_link_key: "source に外部リンクキーが設定されています",
  source_version_gt_1: "source に編集履歴があります（version > 1）",
  name_address_normalize_mismatch:
    "氏名・住所の正規化結果が一致しません（別人の可能性）",
  version_mismatch:
    "他のユーザーが先に更新しました（version が変わっています）",
};

function reasonLabel(r: string): string {
  return MERGE_BLOCK_REASON_LABELS[r] ?? r;
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
        <button
          type="button"
          onClick={handleClick}
          disabled={state === "loading"}
          className="rounded bg-purple-600 px-3 py-1 text-xs font-medium text-white hover:bg-purple-700 disabled:cursor-not-allowed disabled:bg-gray-300 dark:disabled:bg-gray-700"
        >
          {state === "loading" ? "判定中..." : "統合プレビュー"}
        </button>
        {state !== "idle" && (
          <button
            type="button"
            onClick={reset}
            className="text-xs text-gray-500 underline hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
          >
            閉じる
          </button>
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
            {result.eligible
              ? "✓ 統合可能（実行は未実装）"
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
            <dt>正規化キー一致</dt>
            <dd className="font-mono">
              {result.summary.normalizeKeyMatches ? "yes" : "no"}
            </dd>
          </dl>

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
                  <button
                    type="button"
                    onClick={() => setExecuteState("confirm1")}
                    className="rounded bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700"
                  >
                    統合を実行
                  </button>
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
                      <button
                        type="button"
                        onClick={() => setExecuteState("confirm2")}
                        className="rounded bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-700"
                      >
                        次へ
                      </button>
                      <button
                        type="button"
                        onClick={resetExecute}
                        className="rounded border border-gray-300 bg-white px-2 py-1 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
                      >
                        キャンセル
                      </button>
                    </div>
                  </div>
                )}

                {executeState === "confirm2" && (
                  <div className="flex flex-col gap-1 text-xs text-red-800 dark:text-red-300">
                    <p className="font-semibold">
                      ⚠ この操作は元に戻せません。本当に統合しますか？
                    </p>
                    <div className="mt-1 flex gap-1">
                      <button
                        type="button"
                        onClick={handleExecute}
                        className="rounded bg-red-700 px-2 py-1 font-medium text-white hover:bg-red-800"
                      >
                        実行する
                      </button>
                      <button
                        type="button"
                        onClick={resetExecute}
                        className="rounded border border-gray-300 bg-white px-2 py-1 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
                      >
                        キャンセル
                      </button>
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
                    <button
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
