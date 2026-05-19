"use client";

import { useState } from "react";

interface OwnerArchiveButtonProps {
  ownerId: string;
  ownerVersion: number;
  onSuccess: () => void;
}

type State =
  | "idle"
  | "previewing"   // dryRun=true 実行中
  | "confirming"   // dryRun OK → 実行確認ダイアログ
  | "submitting"   // dryRun=false 実行中
  | "done"
  | "error";

// blockReason enum → 日本語ラベル（PII を含めない・enum コードのみ表示）
const BLOCK_REASON_LABELS: Record<string, string> = {
  owner_archived: "既にアーカイブ済みです",
  version_mismatch: "他のユーザーが先に更新しました",
  property_owner_exists: "紐づく物件が存在します",
  note_exists: "備考が入力されています",
  external_link_key_exists: "外部リンクキーが設定されています",
  import_source_unsafe: "取込元が不明または複数候補があります",
  not_delete_candidate: "削除候補の条件を満たしていません",
  address_missing: "住所が未入力のためアーカイブできません",
};

function reasonLabel(r: string): string {
  return BLOCK_REASON_LABELS[r] ?? r;
}

export function OwnerArchiveButton({
  ownerId,
  ownerVersion,
  onSuccess,
}: OwnerArchiveButtonProps) {
  const [state, setState] = useState<State>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [blockReasons, setBlockReasons] = useState<string[]>([]);

  const reset = () => {
    setState("idle");
    setErrorMsg(null);
    setBlockReasons([]);
  };

  const handleClick = async () => {
    setErrorMsg(null);
    setBlockReasons([]);
    setState("previewing");
    try {
      const res = await fetch(
        `/api/admin/owners/${ownerId}/correction/archive`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version: ownerVersion, dryRun: true }),
        },
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrorMsg(j?.error?.message ?? "アーカイブ判定に失敗しました");
        setState("error");
        return;
      }
      if (!j?.eligible) {
        setBlockReasons(Array.isArray(j?.blockReasons) ? j.blockReasons : []);
        setState("error");
        return;
      }
      setState("confirming");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "アーカイブ判定に失敗しました");
      setState("error");
    }
  };

  const handleConfirm = async () => {
    setState("submitting");
    setErrorMsg(null);
    setBlockReasons([]);
    try {
      const res = await fetch(
        `/api/admin/owners/${ownerId}/correction/archive`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version: ownerVersion, dryRun: false }),
        },
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        const reasons = Array.isArray(j?.error?.blockReasons)
          ? j.error.blockReasons
          : [];
        if (reasons.length > 0) setBlockReasons(reasons);
        setErrorMsg(j?.error?.message ?? "アーカイブに失敗しました");
        setState("error");
        return;
      }
      setState("done");
      onSuccess();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "アーカイブに失敗しました");
      setState("error");
    }
  };

  if (state === "done") {
    return (
      <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs text-gray-700">
        アーカイブ済み
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {(state === "idle" || state === "error") && (
        <button
          type="button"
          onClick={handleClick}
          className="rounded bg-amber-600 px-2 py-1 text-xs font-medium text-white hover:bg-amber-700"
        >
          所有者をアーカイブ
        </button>
      )}

      {state === "previewing" && (
        <span className="text-[11px] text-gray-500">判定中...</span>
      )}

      {state === "error" && (errorMsg || blockReasons.length > 0) && (
        <div className="flex flex-col gap-0.5 rounded border border-red-200 bg-red-50 p-1.5 text-[11px] text-red-700">
          {errorMsg && <p>{errorMsg}</p>}
          {blockReasons.length > 0 && (
            <ul className="list-disc pl-4">
              {blockReasons.map((r) => (
                <li key={r}>{reasonLabel(r)}</li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={reset}
            className="mt-0.5 self-start text-[11px] text-red-600 underline"
          >
            閉じる
          </button>
        </div>
      )}

      {state === "confirming" && (
        <div className="flex flex-col gap-1 rounded border border-amber-200 bg-amber-50 p-2 text-xs">
          <p className="font-medium text-amber-800">
            この所有者をアーカイブしますか？
          </p>
          <p className="text-amber-700">
            通常の一覧・検索・所有者選択から除外されます。
          </p>
          <div className="mt-1 flex gap-1">
            <button
              type="button"
              onClick={handleConfirm}
              className="rounded bg-amber-600 px-2 py-1 font-medium text-white hover:bg-amber-700"
            >
              アーカイブ実行
            </button>
            <button
              type="button"
              onClick={reset}
              className="rounded border border-gray-300 bg-white px-2 py-1 text-gray-600 hover:bg-gray-50"
            >
              キャンセル
            </button>
          </div>
        </div>
      )}

      {state === "submitting" && (
        <span className="text-[11px] text-gray-500">アーカイブ中...</span>
      )}
    </div>
  );
}
