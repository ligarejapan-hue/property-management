/**
 * 削除などの確認ダイアログ (UI一貫性 第3弾 ⑪)。
 *
 * ModalShell の上に「キャンセル / 危険操作」の定番フッタを載せた特化部品。
 * 写真・添付・テンプレート等の削除確認(ほぼ同文で4箇所に複製されていた)を
 * 1つに畳む。busy 中は**両方**のボタンを止める(削除の途中でキャンセルを
 * 押せると、閉じた画面と進行中の削除で状態が食い違うため)。
 */
import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "./button";
import { ModalShell } from "./modal-shell";

export interface ConfirmDialogProps {
  title: ReactNode;
  message?: ReactNode;
  confirmLabel?: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({
  title,
  message = "この操作は取り消せません。",
  confirmLabel = "削除",
  busy = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <ModalShell
      size="sm"
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            キャンセル
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm text-gray-500 dark:text-gray-400">{message}</p>
    </ModalShell>
  );
}
