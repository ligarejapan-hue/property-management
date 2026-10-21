"use client";

import { Button } from "@/components/ui/button";
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
      <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700 dark:bg-green-500/10 dark:text-green-300">
        補完済み
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {state === "idle" || state === "error" ? (
        <Button variant="primary" size="sm" onClick={handleClick}>
          住所を補完
        </Button>
      ) : null}

      {state === "error" && errorMsg && (
        <p className="text-[11px] text-red-600 dark:text-red-400">{errorMsg}</p>
      )}

      {state === "confirming" && (
        <div className="flex flex-col gap-1 rounded border border-blue-200 bg-blue-50 p-2 text-xs dark:border-blue-400/20 dark:bg-blue-500/10">
          <p className="font-medium text-blue-800 dark:text-blue-300">住所を補完しますか？</p>
          {previewAddress ? (
            <p className="text-blue-700 break-all dark:text-blue-300">{previewAddress}</p>
          ) : (
            <p className="text-blue-600 dark:text-blue-300">取込元の CSV データから住所を補完します</p>
          )}
          <div className="mt-1 flex gap-1">
            <Button variant="primary" size="sm" onClick={handleConfirm}>
              実行
            </Button>
            <Button variant="ghost" size="sm" onClick={handleCancel}>
              キャンセル
            </Button>
          </div>
        </div>
      )}

      {state === "submitting" && (
        <span className="text-[11px] text-gray-500 dark:text-gray-400">補完中...</span>
      )}
    </div>
  );
}
