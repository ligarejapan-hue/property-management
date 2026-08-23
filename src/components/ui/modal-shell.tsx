"use client";

/**
 * モーダルの器 (UI一貫性 第3弾 ⑪・発注者承認 2026-08-23)。
 *
 * 背景: 26箇所のモーダルが器(overlay+カード+フッタ)を各自コピーしており、
 * overlay の濃さ(40/50/70)とフッタ間隔(gap-2/3)が揺れていた(実測)。
 * 以後の新モーダルはこの器を使う。
 *
 * 実装はネイティブ <dialog> + showModal()(@codex #406 R2 P2)。div の overlay に
 * aria-modal を書くだけでは**フォーカスが背後に抜ける**(Tab で覆われた画面の
 * 操作に届く)ため、閉じ込め・初期フォーカス・閉じた時の呼び出し元への復帰を
 * ブラウザ標準に任せる。規約:
 *   - 背景 = backdrop:bg-black/50 / カード = rounded-lg p-6 shadow-xl(白/dark)
 *   - フッタ = justify-end gap-2(ボタンは共通 Button)
 *   - 見出しと aria-labelledby で紐付け(無名の dialog にしない)
 *
 * 開閉は従来どおり呼び出し側の条件描画({open && <ModalShell/>})。
 * onClose を渡すと Escape(cancel)がそこへ通知される。渡さなければ Escape は
 * 無効化する(⚠ネイティブ dialog は Escape で**見た目だけ**閉じ、React の
 * open 状態と食い違うため、通知先が無いなら閉じさせない)。
 *
 * ⚠写真の拡大表示(lightbox)・全画面ドロワー・透かしは「モーダルの器」では
 *   ないため対象外(走査テストの allow-list 参照)。
 */
import { useEffect, useId, useRef, type ReactNode } from "react";

export interface ModalShellProps {
  title: ReactNode;
  /** 本文。確認だけのダイアログでは省略可。 */
  children?: ReactNode;
  /** ボタン群(共通 Button を渡す)。justify-end gap-2 で並ぶ。 */
  footer: ReactNode;
  size?: "sm" | "md" | "lg";
  /** Escape(cancel)の通知先。省略時は Escape で閉じない(状態の食い違い防止)。 */
  onClose?: () => void;
  className?: string;
}

const SIZE_CLASSES: Record<NonNullable<ModalShellProps["size"]>, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
};

export function ModalShell({
  title,
  children,
  footer,
  size = "md",
  onClose,
  className,
}: ModalShellProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    // マウント=開く。showModal がフォーカスを中へ移し、閉じたら呼び出し元へ戻す。
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        if (onClose) onClose();
        else e.preventDefault();
      }}
      className={`m-auto w-full ${SIZE_CLASSES[size]} rounded-lg bg-white p-6 shadow-xl backdrop:bg-black/50 dark:bg-gray-900${className ? ` ${className}` : ""}`}
    >
      <h2
        id={titleId}
        className="text-lg font-semibold text-gray-900 dark:text-gray-100"
      >
        {title}
      </h2>
      {children !== undefined && <div className="mt-3">{children}</div>}
      <div className="mt-5 flex justify-end gap-2">{footer}</div>
    </dialog>
  );
}
