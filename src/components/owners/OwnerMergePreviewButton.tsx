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

interface OwnerMergePreviewButtonProps {
  masterId: string;
  sourceId: string;
  /** 表示専用ラベル（master / source の識別子）。PII は出さない。 */
  masterLabel: string;
  sourceLabel: string;
}

type State = "idle" | "loading" | "done" | "error";

export function OwnerMergePreviewButton({
  masterId,
  sourceId,
  masterLabel,
  sourceLabel,
}: OwnerMergePreviewButtonProps) {
  const [state, setState] = useState<State>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [result, setResult] = useState<MergePreviewResponse | null>(null);

  // masterId / sourceId が変わったら古い preview 結果を破棄する。
  // 別ペア（例: A/B → A/C）の結果が、変更後のラベル A/C と乖離したまま
  // 表示され続けて operator の判断を誤らせるのを防ぐ。
  useEffect(() => {
    setState("idle");
    setErrorMsg(null);
    setResult(null);
  }, [masterId, sourceId]);

  const reset = () => {
    setState("idle");
    setErrorMsg(null);
    setResult(null);
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
          className="rounded bg-purple-600 px-3 py-1 text-xs font-medium text-white hover:bg-purple-700 disabled:cursor-not-allowed disabled:bg-gray-300"
        >
          {state === "loading" ? "判定中..." : "統合プレビュー"}
        </button>
        {state !== "idle" && (
          <button
            type="button"
            onClick={reset}
            className="text-xs text-gray-500 underline hover:text-gray-700"
          >
            閉じる
          </button>
        )}
      </div>

      {state === "loading" && (
        <p className="text-xs text-gray-500">判定中...</p>
      )}

      {/* 通信失敗（fetch throw / network / offline 等）用の独立エラーバナー。
          result が null のままでもユーザーに失敗が伝わるようにする。
          API が JSON エラーボディを返した HTTP 4xx/5xx ケースは下の result
          ブロックで blockReasons と共に表示する。 */}
      {state === "error" && !result && errorMsg && (
        <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
          <p className="font-medium">プレビューの取得に失敗しました</p>
          <p className="mt-0.5 break-words">{errorMsg}</p>
          <p className="mt-1 text-[11px] text-red-500">
            通信状況を確認してもう一度お試しください。
          </p>
        </div>
      )}

      {result && (
        <div
          className={`rounded-md border p-2 text-xs ${
            result.eligible
              ? "border-green-200 bg-green-50"
              : "border-red-200 bg-red-50"
          }`}
        >
          <p
            className={`mb-1 font-medium ${
              result.eligible ? "text-green-800" : "text-red-800"
            }`}
          >
            {result.eligible
              ? "✓ 統合可能（実行は未実装）"
              : "✗ 統合不可"}
          </p>

          {errorMsg && !result.eligible && (
            <p className="mb-1 text-red-700">{errorMsg}</p>
          )}

          <p className="mb-1 text-gray-600">
            master: <span className="font-mono">{masterLabel}</span> / source:{" "}
            <span className="font-mono">{sourceLabel}</span>
          </p>

          {/* blockReasons */}
          {result.blockReasons.length > 0 && (
            <ul className="mb-2 list-disc pl-4 text-red-700">
              {result.blockReasons.map((r) => (
                <li key={r}>{reasonLabel(r)}</li>
              ))}
            </ul>
          )}

          {/* summary 件数。PII（owner名 / address / メモ本文）は含めない。 */}
          <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-gray-700">
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
                  ? "font-bold text-amber-700"
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

          <p className="mt-2 text-[11px] text-gray-500">
            ※ 統合実行は Phase 2-B-β（別 PR）で対応予定です。
          </p>
        </div>
      )}
    </div>
  );
}
