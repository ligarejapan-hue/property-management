"use client";

/**
 * 「謄本から所有者を反映」ボタン。
 *
 * 添付済みの所有者事項を読み、登録される所有者を **必ず確認画面で見せてから** 登録する。
 * 出すのは「所有者が0件」かつ「所有者事項の謄本がある」物件だけ(判断は呼び出し側)。
 *
 * ⚠読み取れなかったときは黙って登録しない。理由を出して手入力へ誘導する。
 */
import { useCallback, useState } from "react";
import { FileUser, Loader2 } from "lucide-react";

import { ModalShell } from "@/components/ui/modal-shell";
import { Button } from "@/components/ui/button";
import RegistryOwnerPreviewList from "@/components/properties/registry-owner-preview-list";
import {
  fetchRegistryOwnerPreview,
  applyRegistryOwners,
  type RegistryOwnerPreview,
} from "@/lib/api-client";

export interface RegistryOwnerApplyButtonProps {
  propertyId: string;
  /** 反映後に物件を読み直す。 */
  onApplied: () => Promise<void> | void;
}

type Phase = "idle" | "loading" | "confirm" | "applying" | "done";

export default function RegistryOwnerApplyButton({
  propertyId,
  onApplied,
}: RegistryOwnerApplyButtonProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [preview, setPreview] = useState<RegistryOwnerPreview | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const close = useCallback(() => {
    setPhase("idle");
    setPreview(null);
    setErrorMsg(null);
  }, []);

  /** 成功の表示を閉じてから、画面を読み直す。 */
  const finish = useCallback(async () => {
    close();
    await onApplied();
  }, [close, onApplied]);

  const openPreview = useCallback(async () => {
    setPhase("loading");
    setErrorMsg(null);
    try {
      const data = await fetchRegistryOwnerPreview(propertyId);
      setPreview(data);
      setPhase("confirm");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "謄本を読み取れませんでした");
      setPhase("idle");
    }
  }, [propertyId]);

  const apply = useCallback(async () => {
    const attachmentId = preview?.attachment.id;
    if (!attachmentId) return;
    setPhase("applying");
    setErrorMsg(null);
    try {
      // ⚠下見で見せた添付を明示して送る。開いている間に別の謄本が
      //   添付されていたらサーバーが拒否する(見ていない所有者を入れない)。
      await applyRegistryOwners(propertyId, attachmentId);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "登録できませんでした");
      setPhase("confirm");
      return;
    }
    // ⚠ここで**先に成功を見せてから**画面を読み直す。
    //   読み直し(onApplied = ページの fetchProperty)は失敗しても内部で受け止めて
    //   正常に返るため、ここで失敗を捕まえられない。先に閉じてしまうと、読み直しに
    //   失敗したとき画面がエラー表示に切り替わり、利用者は**登録が成功したことを
    //   知るすべが無くなる**。
    setPhase("done");
  }, [propertyId, preview, onApplied, close]);

  const owners = preview?.owners ?? [];
  const canApply = owners.length > 0 && !preview?.alreadyHasOwners;

  return (
    <>
      <button
        type="button"
        onClick={openPreview}
        disabled={phase === "loading"}
        aria-label="添付済みの謄本から所有者を反映する"
        title="添付されている謄本（所有者事項）を読み取って所有者を登録します"
        className="flex items-center gap-1.5 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-60 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 dark:hover:bg-emerald-900/40"
      >
        {phase === "loading" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <FileUser className="h-3.5 w-3.5" />
        )}
        謄本から所有者を反映
      </button>

      {errorMsg && phase === "idle" ? (
        <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
          {errorMsg}
        </p>
      ) : null}

      {phase === "done" ? (
        <ModalShell
          title="謄本から所有者を反映"
          size="md"
          onClose={finish}
          footer={<Button onClick={finish}>閉じる</Button>}
        >
          <p className="text-sm text-gray-800 dark:text-gray-100">
            {owners.length}名の所有者を登録しました。
          </p>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            閉じると物件の表示を読み直します。
          </p>
        </ModalShell>
      ) : null}

      {phase === "confirm" || phase === "applying" ? (
        <ModalShell
          title="謄本から所有者を反映"
          size="md"
          onClose={phase === "applying" ? undefined : close}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={close}
                disabled={phase === "applying"}
              >
                やめる
              </Button>
              <Button
                onClick={apply}
                disabled={!canApply || phase === "applying"}
              >
                {phase === "applying" ? "登録中…" : "この内容で登録"}
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            <RegistryOwnerPreviewList
              owners={owners}
              fileName={preview?.attachment.label ?? ""}
            />
            {preview?.alreadyHasOwners ? (
              <p role="alert" className="text-xs text-amber-700 dark:text-amber-400">
                この物件にはすでに所有者が登録されています。二重に登録しないため、ここからは反映できません。
              </p>
            ) : null}
            {errorMsg ? (
              <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                {errorMsg}
              </p>
            ) : null}
          </div>
        </ModalShell>
      ) : null}
    </>
  );
}
