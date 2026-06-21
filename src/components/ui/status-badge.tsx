import type { ReactNode } from "react";

/**
 * UIトーン統一 v2「静かな精密さ」(PR-B): ステータスバッジの共通レシピ。
 *
 * - 状態は 5 intent(success/warning/error/info/neutral)に集約する。
 *   yellow は使わず amber に統一(scheduled 等)。
 * - ロールは状態色と衝突しない専用色(violet=管理者系 / sky=中間ロール)。
 *   ADMIN=red は「エラー」と視覚的に競合していたため分離した。
 * - レシピは bg-*-50 + text-*-700 + ring(GitHub Primer / Linear 系)。
 *   背景が軽く、dense なテーブルに並んでも色の洪水にならない。
 * - 形状: 状態 = rounded-full(pill)/ 分類タグ = rounded(tag)。
 *
 * 注意: admin/owners/correction 系の「分類タグ」(orphan=orange,
 * address_null=yellow, duplicate=purple 等)は対象外。色の区別自体が
 * 仕様としてテストでロックされているため(owner-correction-whitespace-ui)、
 * 扱いは別途判断する。
 */
export type BadgeIntent =
  | "success"
  | "warning"
  | "error"
  | "info"
  | "neutral"
  // ロール専用色(状態とは別軸)
  | "violet"
  | "sky";

const INTENT_STYLES: Record<BadgeIntent, { box: string; dot: string }> = {
  success: {
    box: "bg-green-50 text-green-700 ring-green-600/20 dark:bg-green-500/10 dark:text-green-300 dark:ring-green-400/20",
    dot: "bg-green-600 dark:bg-green-500",
  },
  warning: {
    box: "bg-amber-50 text-amber-700 ring-amber-600/25 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/25",
    dot: "bg-amber-600 dark:bg-amber-500",
  },
  error: {
    box: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-400/20",
    dot: "bg-red-600 dark:bg-red-500",
  },
  info: {
    box: "bg-blue-50 text-blue-700 ring-blue-600/20 dark:bg-blue-500/10 dark:text-blue-300 dark:ring-blue-400/20",
    dot: "bg-blue-600 dark:bg-blue-500",
  },
  neutral: {
    box: "bg-gray-50 text-gray-600 ring-gray-500/20 dark:bg-gray-400/10 dark:text-gray-300 dark:ring-gray-400/20",
    dot: "bg-gray-400 dark:bg-gray-500",
  },
  violet: {
    box: "bg-violet-50 text-violet-700 ring-violet-600/20 dark:bg-violet-500/10 dark:text-violet-300 dark:ring-violet-400/20",
    dot: "bg-violet-600 dark:bg-violet-500",
  },
  sky: {
    box: "bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-400/20",
    dot: "bg-sky-600 dark:bg-sky-500",
  },
};

/**
 * intent の色レシピ(背景+文字+ring)だけをクラス文字列で返す。
 * サイズ・形状を独自に持つ既存 span に色だけ差し込みたい箇所用。
 */
export function badgeIntentClass(intent: BadgeIntent): string {
  return `ring-1 ring-inset ${INTENT_STYLES[intent].box}`;
}

/** 登記ステータス → intent(properties 一覧/詳細で共用) */
export const REGISTRY_STATUS_INTENT: Record<string, BadgeIntent> = {
  obtained: "success",
  scheduled: "warning",
  unconfirmed: "error",
};

/** DM判断 → intent(properties 一覧/詳細で共用) */
export const DM_STATUS_INTENT: Record<string, BadgeIntent> = {
  send: "success",
  no_send: "error",
  hold: "neutral",
};

/** 認可ロール(ADMIN/MANAGER/...)→ intent(header) */
export const ROLE_INTENT: Record<string, BadgeIntent> = {
  ADMIN: "violet",
  MANAGER: "sky",
  OPERATOR: "neutral",
  VIEWER: "neutral",
};

/** ユーザー管理画面のロールキー(admin/office_staff/field_staff)→ intent */
export const USER_ROLE_INTENT: Record<string, BadgeIntent> = {
  admin: "violet",
  office_staff: "sky",
  field_staff: "neutral",
};

interface StatusBadgeProps {
  intent: BadgeIntent;
  /** pill=状態(rounded-full・dot 付き) / tag=分類(rounded・dot なし) */
  shape?: "pill" | "tag";
  /** dot の明示制御(省略時: pill のみ表示) */
  dot?: boolean;
  className?: string;
  children: ReactNode;
}

/** 標準サイズ(text-xs)のステータスバッジ。 */
export default function StatusBadge({
  intent,
  shape = "pill",
  dot,
  className = "",
  children,
}: StatusBadgeProps) {
  const styles = INTENT_STYLES[intent];
  const showDot = dot ?? shape === "pill";
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
        shape === "pill" ? "rounded-full" : "rounded"
      } ${styles.box} ${className}`}
    >
      {showDot ? (
        <span
          aria-hidden
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${styles.dot}`}
        />
      ) : null}
      {children}
    </span>
  );
}
