/**
 * 共通ボタン (UI一貫性 第1弾 ③・発注者承認 2026-08-23)。
 *
 * 背景: 共通部品が無く全ボタンが手書きだったため、主ボタン(藍)だけで
 * 大きさ・字の太さの組み合わせが10種類以上に増殖していた(実測)。
 * 以後、通常のボタンはこの部品を使う。規約:
 *   - 役割: primary(藍・主動作) / secondary(枠線・補助) / danger(赤・破壊的)
 *   - 大きさ: md(px-4 py-2 text-sm) / sm(px-3 py-1.5 text-xs)
 *   - 角丸は rounded-md(操作要素の規約)
 *   - disabled は opacity-60 + not-allowed(押せない理由は title で説明する)
 *
 * ⚠特殊な操作(3状態切替の aria-pressed 群・地図のFAB・実況の中止等)は対象外。
 *   それらは専用の見た目が仕様なので、この部品に寄せない。
 * ⚠type は明示しない限り "button"(form 内で意図せぬ submit をしない)。
 */
import { forwardRef, type ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "danger";
export type ButtonSize = "md" | "sm";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    "bg-indigo-600 text-white hover:bg-indigo-700 disabled:hover:bg-indigo-600",
  secondary:
    "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:hover:bg-white dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800 dark:disabled:hover:bg-gray-900",
  danger:
    "bg-red-600 text-white hover:bg-red-700 disabled:hover:bg-red-600",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  md: "px-4 py-2 text-sm",
  sm: "px-3 py-1.5 text-xs",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { variant = "primary", size = "md", type = "button", className, ...rest },
    ref,
  ) {
    const base =
      "inline-flex items-center justify-center gap-1.5 rounded-md font-medium disabled:cursor-not-allowed disabled:opacity-60";
    return (
      <button
        ref={ref}
        type={type}
        className={`${base} ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]}${className ? ` ${className}` : ""}`}
        {...rest}
      />
    );
  },
);
