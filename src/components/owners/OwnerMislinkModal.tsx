"use client";

import { useEffect, useState } from "react";

// blockReason enum → 日本語ラベル（owner-mislink.ts と整合）
const MISLINK_BLOCK_REASON_LABELS: Record<string, string> = {
  missing_operation: "操作種別が選択されていません",
  missing_target_for_relink: "付け替え先の所有者が選択されていません",
  same_owner_id: "現在の所有者と付け替え先が同一です",
  property_owner_not_found: "対象の物件×所有者リンクが見つかりません",
  property_owner_state_mismatch:
    "物件と所有者リンクの状態が一致しません（並行更新の可能性）",
  current_owner_id_mismatch:
    "現在の所有者IDが一致しません（並行更新の可能性）",
  property_not_found: "物件が見つかりません",
  property_archived: "物件がアーカイブ済みです",
  current_owner_not_found: "現在の所有者が見つかりません",
  target_owner_not_found: "付け替え先の所有者が見つかりません",
  target_owner_archived: "付け替え先の所有者がアーカイブ済みです",
  target_already_linked:
    "付け替え先の所有者は既にこの物件に紐づいています（先に既存リンクを確認してください）",
  version_mismatch: "他のユーザーが先に更新しました（version 不一致）",
};

function reasonLabel(r: string): string {
  return MISLINK_BLOCK_REASON_LABELS[r] ?? r;
}

interface MislinkPreviewSummary {
  currentOwnerId: string;
  currentOwnerArchived: boolean;
  targetOwnerId: string | null;
  targetOwnerArchived: boolean;
  targetAlreadyLinked: boolean;
  propertyArchived: boolean;
  ownerMemoCountOnThisProperty: number;
  currentOwnerVersion: number | null;
  targetOwnerVersion: number | null;
  propertyVersion: number | null;
}

interface MislinkPreviewResponse {
  eligible: boolean;
  blockReasons: string[];
  propertyId: string;
  propertyOwnerId: string;
  operation: "remove" | "relink";
  summary: MislinkPreviewSummary;
}

interface MislinkExecuteResult {
  removed: boolean;
  previousOwnerId: string;
  newOwnerId: string | null;
  currentOwnerVersion: number;
  targetOwnerVersion: number | null;
  propertyVersion: number;
}

interface OwnerSearchHit {
  id: string;
  name: string;
  nameKana: string | null;
  phone: string | null;
  address: string | null;
  externalLinkKey: string | null;
}

interface OwnerMislinkModalProps {
  propertyId: string;
  propertyOwnerId: string;
  currentOwnerId: string;
  /** 表示専用ラベル。PII を含む可能性があり、既存 PII 表示制御済みの値のみ渡す。 */
  currentOwnerLabel: string;
  onClose: () => void;
  onExecuted?: () => void;
}

type Operation = "remove" | "relink";
type State = "idle" | "preview_loading" | "preview_done" | "preview_error";
type ExecuteState =
  | "idle"
  | "confirm1"
  | "confirm2"
  | "executing"
  | "executed"
  | "execute_error";

export function OwnerMislinkModal({
  propertyId,
  propertyOwnerId,
  currentOwnerId,
  currentOwnerLabel,
  onClose,
  onExecuted,
}: OwnerMislinkModalProps) {
  const [operation, setOperation] = useState<Operation>("remove");

  // target owner 検索
  const [searchQ, setSearchQ] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchHits, setSearchHits] = useState<OwnerSearchHit[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selectedTarget, setSelectedTarget] = useState<OwnerSearchHit | null>(
    null,
  );

  // preview state
  const [previewState, setPreviewState] = useState<State>("idle");
  const [previewErrorMsg, setPreviewErrorMsg] = useState<string | null>(null);
  const [previewResult, setPreviewResult] =
    useState<MislinkPreviewResponse | null>(null);

  // execute state（preview とは独立）
  const [executeState, setExecuteState] = useState<ExecuteState>("idle");
  const [executeErrorMsg, setExecuteErrorMsg] = useState<string | null>(null);
  const [executeBlockReasons, setExecuteBlockReasons] = useState<string[]>([]);
  const [executeResult, setExecuteResult] = useState<MislinkExecuteResult | null>(
    null,
  );

  // operation / target が変わったら古い preview / execute 結果を破棄
  useEffect(() => {
    setPreviewState("idle");
    setPreviewErrorMsg(null);
    setPreviewResult(null);
    setExecuteState("idle");
    setExecuteErrorMsg(null);
    setExecuteBlockReasons([]);
    setExecuteResult(null);
  }, [operation, selectedTarget?.id]);

  // 検索: debounce
  useEffect(() => {
    if (operation !== "relink") return;
    const q = searchQ.trim();
    if (q.length < 1) {
      setSearchHits([]);
      return;
    }
    const timer = setTimeout(async () => {
      setSearchLoading(true);
      setSearchError(null);
      try {
        const res = await fetch(
          `/api/owners/search?q=${encodeURIComponent(q)}`,
        );
        const j = await res.json().catch(() => ({}));
        if (!res.ok) {
          setSearchError(j?.error?.message ?? "検索に失敗しました");
          setSearchHits([]);
          return;
        }
        const hits = (j?.data ?? []) as OwnerSearchHit[];
        // current owner を結果から除外
        setSearchHits(hits.filter((h) => h.id !== currentOwnerId));
      } catch (e) {
        setSearchError(
          e instanceof Error ? e.message : "検索に失敗しました",
        );
        setSearchHits([]);
      } finally {
        setSearchLoading(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQ, operation, currentOwnerId]);

  const canPreview =
    operation === "remove" ||
    (operation === "relink" && selectedTarget !== null);

  const handlePreview = async () => {
    if (!canPreview) return;
    setPreviewState("preview_loading");
    setPreviewErrorMsg(null);
    setPreviewResult(null);
    try {
      const res = await fetch(
        "/api/admin/owners/correction/mislink-preview",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operation,
            propertyId,
            propertyOwnerId,
            currentOwnerId,
            targetOwnerId:
              operation === "relink" ? selectedTarget?.id : undefined,
          }),
        },
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        const reasons = Array.isArray(j?.error?.blockReasons)
          ? (j.error.blockReasons as string[])
          : [];
        setPreviewResult(null);
        setPreviewErrorMsg(j?.error?.message ?? "プレビューに失敗しました");
        // blocked でも UI に reasons を出すために state は preview_done で
        // result.eligible=false / blockReasons をセット
        if (reasons.length > 0) {
          setPreviewResult({
            eligible: false,
            blockReasons: reasons,
            propertyId,
            propertyOwnerId,
            operation,
            summary: {
              currentOwnerId,
              currentOwnerArchived: false,
              targetOwnerId: selectedTarget?.id ?? null,
              targetOwnerArchived: false,
              targetAlreadyLinked: false,
              propertyArchived: false,
              ownerMemoCountOnThisProperty: 0,
              currentOwnerVersion: null,
              targetOwnerVersion: null,
              propertyVersion: null,
            },
          });
          setPreviewState("preview_done");
          return;
        }
        setPreviewState("preview_error");
        return;
      }
      setPreviewResult(j as MislinkPreviewResponse);
      setPreviewState("preview_done");
    } catch (e) {
      setPreviewResult(null);
      setPreviewErrorMsg(
        e instanceof Error ? e.message : "プレビューに失敗しました",
      );
      setPreviewState("preview_error");
    }
  };

  const handleExecute = async () => {
    if (!previewResult || !previewResult.eligible) return;
    if (operation === "relink" && !selectedTarget) return;
    setExecuteState("executing");
    setExecuteErrorMsg(null);
    setExecuteBlockReasons([]);
    try {
      const res = await fetch("/api/admin/owners/correction/mislink", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation,
          propertyId,
          propertyOwnerId,
          currentOwnerId,
          targetOwnerId: operation === "relink" ? selectedTarget?.id : null,
          currentOwnerVersion: previewResult.summary.currentOwnerVersion,
          targetOwnerVersion: previewResult.summary.targetOwnerVersion,
          propertyVersion: previewResult.summary.propertyVersion,
          dryRun: false,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        const reasons = Array.isArray(j?.error?.blockReasons)
          ? (j.error.blockReasons as string[])
          : [];
        setExecuteBlockReasons(reasons);
        setExecuteErrorMsg(j?.error?.message ?? "誤紐づき修正に失敗しました");
        setExecuteResult(null);
        setExecuteState("execute_error");
        return;
      }
      setExecuteResult(j?.result as MislinkExecuteResult);
      setExecuteState("executed");
      onExecuted?.();
    } catch (e) {
      setExecuteResult(null);
      setExecuteErrorMsg(
        e instanceof Error ? e.message : "誤紐づき修正に失敗しました",
      );
      setExecuteState("execute_error");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-lg bg-white p-4 shadow-xl">
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-gray-900">
            誤紐づき修正
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-gray-500 hover:text-gray-700"
          >
            閉じる
          </button>
        </div>

        <div className="mb-3 text-xs text-gray-600">
          現在の所有者:{" "}
          <span className="font-mono">{currentOwnerLabel}</span>
        </div>

        {/* 操作選択 */}
        <fieldset className="mb-3 rounded border border-gray-200 p-2 text-xs">
          <legend className="px-1 text-gray-500">操作</legend>
          <label className="mr-3">
            <input
              type="radio"
              name="mislink-op"
              value="remove"
              checked={operation === "remove"}
              onChange={() => {
                setOperation("remove");
                setSelectedTarget(null);
              }}
              className="mr-1"
            />
            物件から外す
          </label>
          <label>
            <input
              type="radio"
              name="mislink-op"
              value="relink"
              checked={operation === "relink"}
              onChange={() => setOperation("relink")}
              className="mr-1"
            />
            別の所有者に付け替える
          </label>
        </fieldset>

        {/* target 検索 */}
        {operation === "relink" && (
          <div className="mb-3 rounded border border-gray-200 p-2">
            <label className="mb-1 block text-xs text-gray-600">
              付け替え先の所有者を検索
            </label>
            <input
              type="text"
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              placeholder="氏名 / 電話 / 住所 / リンクキー で検索"
              className="w-full rounded border border-gray-300 px-2 py-1 text-xs"
            />
            {searchLoading && (
              <p className="mt-1 text-xs text-gray-500">検索中...</p>
            )}
            {searchError && (
              <p className="mt-1 text-xs text-red-600">{searchError}</p>
            )}
            {!searchLoading && searchHits.length > 0 && (
              <ul className="mt-1 max-h-40 overflow-y-auto rounded border border-gray-200">
                {searchHits.map((h) => (
                  <li
                    key={h.id}
                    className={`cursor-pointer border-b border-gray-100 px-2 py-1 text-xs last:border-b-0 hover:bg-indigo-50 ${
                      selectedTarget?.id === h.id ? "bg-indigo-100" : ""
                    }`}
                    onClick={() => setSelectedTarget(h)}
                  >
                    <div className="font-medium">{h.name}</div>
                    <div className="font-mono text-[10px] text-gray-500">
                      {h.id.slice(0, 8)}…
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {selectedTarget && (
              <div className="mt-2 rounded bg-blue-50 px-2 py-1 text-xs text-blue-800">
                選択: {selectedTarget.name} (
                <span className="font-mono">
                  {selectedTarget.id.slice(0, 8)}…
                </span>
                )
              </div>
            )}
          </div>
        )}

        {/* プレビュー */}
        <div className="mb-3 flex gap-2">
          <button
            type="button"
            onClick={handlePreview}
            disabled={!canPreview || previewState === "preview_loading"}
            className="rounded bg-purple-600 px-3 py-1 text-xs font-medium text-white hover:bg-purple-700 disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            {previewState === "preview_loading"
              ? "判定中..."
              : "修正プレビュー"}
          </button>
        </div>

        {previewState === "preview_error" && previewErrorMsg && (
          <div className="mb-3 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
            <p className="font-medium">プレビューの取得に失敗しました</p>
            <p className="mt-0.5 break-words">{previewErrorMsg}</p>
            <p className="mt-1 text-[11px] text-red-500">
              通信状況を確認してもう一度お試しください。
            </p>
          </div>
        )}

        {previewResult && (
          <div
            className={`mb-3 rounded-md border p-2 text-xs ${
              previewResult.eligible
                ? "border-green-200 bg-green-50"
                : "border-red-200 bg-red-50"
            }`}
          >
            <p
              className={`mb-1 font-medium ${
                previewResult.eligible ? "text-green-800" : "text-red-800"
              }`}
            >
              {previewResult.eligible ? "✓ 修正可能" : "✗ 修正不可"}
            </p>
            <p className="mb-1 text-gray-600">
              操作:{" "}
              <span className="font-mono">
                {previewResult.operation === "remove" ? "remove" : "relink"}
              </span>
            </p>

            {previewResult.blockReasons.length > 0 && (
              <ul className="mb-2 list-disc pl-4 text-red-700">
                {previewResult.blockReasons.map((r) => (
                  <li key={r}>{reasonLabel(r)}</li>
                ))}
              </ul>
            )}

            {/* OwnerMemo 警告 */}
            {previewResult.summary.ownerMemoCountOnThisProperty > 0 && (
              <div className="mb-2 rounded border border-amber-200 bg-amber-50 p-1.5 text-amber-800">
                ⚠ この物件に関連するメモが{" "}
                {previewResult.summary.ownerMemoCountOnThisProperty}{" "}
                件あります。修正後もメモは元の所有者に残ります。
              </div>
            )}

            <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-gray-700">
              <dt>currentOwner archived</dt>
              <dd className="font-mono">
                {previewResult.summary.currentOwnerArchived ? "yes" : "no"}
              </dd>
              <dt>targetOwner archived</dt>
              <dd className="font-mono">
                {previewResult.summary.targetOwnerArchived ? "yes" : "no"}
              </dd>
              <dt>target 既存リンク</dt>
              <dd className="font-mono">
                {previewResult.summary.targetAlreadyLinked ? "yes" : "no"}
              </dd>
              <dt>property archived</dt>
              <dd className="font-mono">
                {previewResult.summary.propertyArchived ? "yes" : "no"}
              </dd>
              <dt>currentOwner version</dt>
              <dd className="font-mono">
                {previewResult.summary.currentOwnerVersion ?? "—"}
              </dd>
              <dt>targetOwner version</dt>
              <dd className="font-mono">
                {previewResult.summary.targetOwnerVersion ?? "—"}
              </dd>
              <dt>property version</dt>
              <dd className="font-mono">
                {previewResult.summary.propertyVersion ?? "—"}
              </dd>
            </dl>
          </div>
        )}

        {/* execute UI: eligible=true でのみ表示 */}
        {previewResult &&
          previewResult.eligible &&
          executeState !== "executed" && (
            <div className="rounded-md border border-red-300 bg-red-50 p-2">
              <p className="mb-1 text-xs font-semibold text-red-800">
                ⚠ この操作は元に戻せません
              </p>

              {executeState === "idle" && (
                <button
                  type="button"
                  onClick={() => setExecuteState("confirm1")}
                  className="rounded bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700"
                >
                  誤紐づき修正を実行
                </button>
              )}

              {executeState === "confirm1" && (
                <div className="flex flex-col gap-1 text-xs text-red-800">
                  <p>
                    操作:{" "}
                    <span className="font-mono">
                      {previewResult.operation}
                    </span>
                  </p>
                  {operation === "relink" && selectedTarget && (
                    <p>
                      付け替え先:{" "}
                      <span className="font-mono">
                        {selectedTarget.id.slice(0, 8)}…
                      </span>
                    </p>
                  )}
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
                      onClick={() => setExecuteState("idle")}
                      className="rounded border border-gray-300 bg-white px-2 py-1 text-gray-600 hover:bg-gray-50"
                    >
                      キャンセル
                    </button>
                  </div>
                </div>
              )}

              {executeState === "confirm2" && (
                <div className="flex flex-col gap-1 text-xs text-red-800">
                  <p className="font-semibold">
                    ⚠ この操作は元に戻せません。本当に修正しますか？
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
                      onClick={() => setExecuteState("idle")}
                      className="rounded border border-gray-300 bg-white px-2 py-1 text-gray-600 hover:bg-gray-50"
                    >
                      キャンセル
                    </button>
                  </div>
                </div>
              )}

              {executeState === "executing" && (
                <p className="text-xs text-gray-600">修正中...</p>
              )}

              {executeState === "execute_error" && (
                <div className="flex flex-col gap-0.5 text-xs text-red-700">
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
                    onClick={() => setExecuteState("idle")}
                    className="mt-1 self-start text-[11px] text-red-600 underline"
                  >
                    閉じる
                  </button>
                </div>
              )}
            </div>
          )}

        {/* 成功表示 */}
        {executeState === "executed" && executeResult && (
          <div className="rounded-md border border-green-300 bg-green-50 p-2 text-xs text-green-800">
            <p className="mb-1 font-semibold">✓ 修正が完了しました</p>
            <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5">
              <dt>操作</dt>
              <dd className="font-mono">{operation}</dd>
              <dt>removed</dt>
              <dd className="font-mono">
                {executeResult.removed ? "yes" : "no"}
              </dd>
              <dt>currentOwner version</dt>
              <dd className="font-mono">
                {executeResult.currentOwnerVersion}
              </dd>
              <dt>targetOwner version</dt>
              <dd className="font-mono">
                {executeResult.targetOwnerVersion ?? "—"}
              </dd>
              <dt>property version</dt>
              <dd className="font-mono">{executeResult.propertyVersion}</dd>
            </dl>
            <button
              type="button"
              onClick={onClose}
              className="mt-2 rounded bg-gray-600 px-2 py-1 text-xs font-medium text-white hover:bg-gray-700"
            >
              閉じる
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
