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
 *
 * UIの統一 第2回(2026-10-19・設計書 docs/superpowers/specs/2026-10-19-ui-unify-motion-design.md):
 *   - ghost=枠なし(一覧の行内操作) / lg=スマホの主操作(高さ44px)
 *   - loading=くるくる+文言・自動で押せない(二度押し防止) / done=✓+文言(戻すのは呼び出し側)
 *   - 処理中・完了の間も元の文言を invisible で同じマスに重ねて残し、幅を縮めない(隣のボタンが動かない)
 */
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Check, Loader2 } from "lucide-react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost" | "success";
export type ButtonSize = "md" | "sm" | "lg";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    "bg-indigo-600 text-white shadow-xs hover:bg-indigo-700 hover:shadow-sm disabled:shadow-none disabled:hover:bg-indigo-600",
  secondary:
    "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:hover:bg-white dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800 dark:disabled:hover:bg-gray-900",
  danger:
    "bg-red-600 text-white hover:bg-red-700 disabled:hover:bg-red-600",
  // 第3回: 完了・成功の意味の操作は緑のまま残す(設計書 §1「状態の色は残す」)
  success:
    "bg-green-600 text-white hover:bg-green-700 disabled:hover:bg-green-600",
  ghost:
    "bg-transparent hover:bg-gray-100 disabled:hover:bg-transparent dark:hover:bg-gray-800",
};

// ghost の既定の文字色。呼び出し側が文字色を渡したときは付けない(第3回)。
// ⚠同じ種類のクラスが2つあると、勝つのは className の順ではなく CSS の並び順(色名の
//   アルファベット順など)になり、text-blue-600 が text-gray-700 に負ける。
const GHOST_TEXT = "text-gray-700 dark:text-gray-200";
const TEXT_COLOR = /^text-(?:inherit|current|white|black|transparent|[a-z]+-\d{2,3}(?:\/\d+)?)$/;
const JUSTIFY = /^justify-/;
const hasToken = (className: string | undefined, re: RegExp) =>
  !!className && className.split(/\s+/).some((t) => re.test(t));

const SIZE_CLASSES: Record<ButtonSize, string> = {
  md: "px-4 py-2 text-sm",
  sm: "px-3 py-1.5 text-xs",
  lg: "min-h-11 px-5 py-2.5 text-base",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** 処理中。くるくる+loadingLabel を出し、自動で押せなくする(二度押し防止)。 */
  loading?: boolean;
  /** 処理中の文言。既定「処理中」。 */
  loadingLabel?: string;
  /** 完了。✓+doneLabel を出す。戻すのは呼び出し側(1.2秒後に false にする)。 */
  done?: boolean;
  /** 完了の文言。既定「完了しました」。 */
  doneLabel?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "primary",
      size = "md",
      type = "button",
      loading = false,
      loadingLabel = "処理中",
      done = false,
      doneLabel = "完了しました",
      disabled,
      className,
      children,
      ...rest
    },
    ref,
  ) {
    // 呼び出し側が並びの向き・文字色を渡したら、既定のほうを外す(上の GHOST_TEXT の⚠と同じ理由)。
    const justify = hasToken(className, JUSTIFY) ? "" : " justify-center";
    const base = `relative inline-flex items-center${justify} gap-1.5 rounded-md font-medium disabled:cursor-not-allowed disabled:opacity-60`;
    const variantClasses =
      variant === "ghost" && !hasToken(className, TEXT_COLOR)
        ? `${VARIANT_CLASSES.ghost} ${GHOST_TEXT}`
        : VARIANT_CLASSES[variant];
    // ⚠done を優先(完了の直後に loading が残っていても✓を見せる)。
    const state: "idle" | "loading" | "done" = done ? "done" : loading ? "loading" : "idle";
    return (
      <button
        ref={ref}
        type={type}
        disabled={disabled || state === "loading"}
        aria-busy={state === "loading" ? true : undefined}
        className={`${base} ${variantClasses} ${SIZE_CLASSES[size]}${className ? ` ${className}` : ""}`}
        {...rest}
      >
        {state === "idle" ? (
          children
        ) : (
          // 元の文言と処理中/完了の文言を、同じグリッドのマスに重ねる。幅は2枚の広いほうになり、
          // 元の文言はふだんと同じ並べ方(アイコンと文字の間隔)で隠れて残る=アイコン付きでも縮まない。
          // ⚠absolute で重ねると、元より長い文言(「完了しました」)がボタンからはみ出す(提出前レビュー指摘)。
          <span className="grid">
            <span
              className="invisible inline-flex items-center justify-center gap-1.5 whitespace-nowrap [grid-area:1/1]"
              aria-hidden="true"
            >
              {children}
            </span>
            <span className="inline-flex items-center justify-center gap-1.5 whitespace-nowrap [grid-area:1/1]">
              {state === "loading" ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Check className="h-4 w-4 animate-pm-pop motion-reduce:animate-none" aria-hidden="true" />
              )}
              {state === "loading" ? loadingLabel : doneLabel}
            </span>
          </span>
        )}
      </button>
    );
  },
);
