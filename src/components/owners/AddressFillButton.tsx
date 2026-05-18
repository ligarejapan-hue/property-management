"use client";

import { useState } from "react";

interface AddressFillButtonProps {
  ownerId: string;
  ownerVersion: number;
  /** dry-run 時点で表示されていた住所候補（確認ダイアログ表示用）。masked されている場合は null。 */
  previewAddress: string | null;
  onSuccess: () => void;
}

type State = "idle" | "confirming" | "submitting" | "done" | "error";

export function AddressFillButton({
  ownerId,
  ownerVersion,
  previewAddress,
  onSuccess,
}: AddressFillButtonProps) {
  const [state, setState] = useState<State>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleClick = () => {
    setErrorMsg(null);
    setState("confirming");
  };

  const handleCancel = () => {
    setState("idle");
  };

  const handleConfirm = async () => {
    setState("submitting");
    setErrorMsg(null);
    try {
      const res = await fetch(
        `/api/admin/owners/${ownerId}/correction/address-fill`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version: ownerVersion }),
        },
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error?.message ?? "住所補完に失敗しました");
      }
      setState("done");
      onSuccess();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "住所補完に失敗しました");
      setState("error");
    }
  };

  if (state === "done") {
    return (
      <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">
        補完済み
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {state === "idle" || state === "error" ? (
        <button
          type="button"
          onClick={handleClick}
          className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700"
        >
          住所を補完
        </button>
      ) : null}

      {state === "error" && errorMsg && (
        <p className="text-[11px] text-red-600">{errorMsg}</p>
      )}

      {state === "confirming" && (
        <div className="flex flex-col gap-1 rounded border border-blue-200 bg-blue-50 p-2 text-xs">
          <p className="font-medium text-blue-800">住所を補完しますか？</p>
          {previewAddress ? (
            <p className="text-blue-700 break-all">{previewAddress}</p>
          ) : (
            <p className="text-blue-600">取込元の CSV データから住所を補完します</p>
          )}
          <div className="mt-1 flex gap-1">
            <button
              type="button"
              onClick={handleConfirm}
              className="rounded bg-blue-600 px-2 py-1 font-medium text-white hover:bg-blue-700"
            >
              実行
            </button>
            <button
              type="button"
              onClick={handleCancel}
              className="rounded border border-gray-300 bg-white px-2 py-1 text-gray-600 hover:bg-gray-50"
            >
              キャンセル
            </button>
          </div>
        </div>
      )}

      {state === "submitting" && (
        <span className="text-[11px] text-gray-500">補完中...</span>
      )}
    </div>
  );
}
