/**
 * モーダルの器 (UI一貫性 第3弾 ⑪・発注者承認 2026-08-23)。
 *
 * 背景: 26箇所のモーダルが器(overlay+カード+フッタ)を各自コピーしており、
 * overlay の濃さ(40/50/70)とフッタ間隔(gap-2/3)が揺れていた(実測)。
 * 以後の新モーダルはこの器を使う。規約:
 *   - overlay = bg-black/50 + p-4(画面端の余白)
 *   - カード = rounded-lg p-6 shadow-xl(白/dark:gray-900)
 *   - フッタ = justify-end gap-2(ボタンは共通 Button)
 *   - role="dialog" aria-modal(手書き実装には無かった)
 *
 * ⚠写真の拡大表示(lightbox)・全画面ドロワー・透かしは「モーダルの器」では
 *   ないため対象外(走査テストの allow-list 参照)。
 * ⚠開閉の状態・Escape 等の振る舞いは呼び出し側の責務(器は見た目だけ)。
 */
import type { ReactNode } from "react";

export interface ModalShellProps {
  title: ReactNode;
  /** 本文。確認だけのダイアログでは省略可。 */
  children?: ReactNode;
  /** ボタン群(共通 Button を渡す)。justify-end gap-2 で並ぶ。 */
  footer: ReactNode;
  size?: "sm" | "md" | "lg";
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
  className,
}: ModalShellProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        className={`w-full ${SIZE_CLASSES[size]} rounded-lg bg-white p-6 shadow-xl dark:bg-gray-900${className ? ` ${className}` : ""}`}
      >
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {title}
        </h2>
        {children !== undefined && <div className="mt-3">{children}</div>}
        <div className="mt-5 flex justify-end gap-2">{footer}</div>
      </div>
    </div>
  );
}
