/**
 * 共通ページ送り (UI一貫性 第2弾 ⑨・発注者承認 2026-08-23)。
 *
 * 背景: 「前へ/次へ」が7画面で個別実装され、件数表示が「N件中 X〜Y」
 * 「全N件中X〜Y件」等に揺れていた(実測)。以後ページ送りはこの部品を使う。
 * 規約:
 *   - 件数表示は「全 N 件中 X〜Y 件を表示」・0件時は「全 0 件」のみ
 *   - ボタンは共通 Button(secondary/sm)・端では disabled
 *   - busy(読み込み中)は両方向とも disabled(読み込み中の連打で
 *     ページ状態と表示が食い違うのを防ぐ)
 */
import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "./button";

export interface PaginationProps {
  page: number;
  totalPages: number;
  /** 総件数。渡すと「全 N 件中 X〜Y 件を表示」を出す(pageSize も必要)。 */
  total?: number;
  pageSize?: number;
  /** 読み込み中は両方向とも押せない。 */
  busy?: boolean;
  onPrev: () => void;
  onNext: () => void;
  /** 画面固有の補助操作(表示件数切替・ページジャンプ等)。前へ/次への左に並ぶ。 */
  children?: ReactNode;
  className?: string;
}

export function Pagination({
  page,
  totalPages,
  total,
  pageSize,
  busy = false,
  onPrev,
  onNext,
  children,
  className,
}: PaginationProps) {
  const shownTotalPages = Math.max(totalPages, 1);
  const hasCount = total !== undefined && pageSize !== undefined && pageSize > 0;
  const rangeStart = hasCount && total > 0 ? (page - 1) * pageSize + 1 : 0;
  const rangeEnd = hasCount && total > 0 ? Math.min(page * pageSize, total) : 0;
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-2 text-sm text-gray-600 tabular-nums dark:text-gray-300${className ? ` ${className}` : ""}`}
    >
      <div>
        {hasCount &&
          (total === 0 ? (
            <span>全 0 件</span>
          ) : (
            <span>
              全 <strong>{total}</strong> 件中 <strong>{rangeStart}</strong>
              〜<strong>{rangeEnd}</strong> 件を表示
            </span>
          ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {children}
        {/* min-h-[44px]=スマホのタップ寸法(モバイルUI改修の規約)。デスクトップは通常寸。 */}
        <Button
          variant="secondary"
          size="sm"
          className="min-h-[44px] sm:min-h-0"
          onClick={onPrev}
          disabled={busy || page <= 1}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          前へ
        </Button>
        <span className="px-1 text-gray-500 dark:text-gray-400">
          {page} / {shownTotalPages}
        </span>
        <Button
          variant="secondary"
          size="sm"
          className="min-h-[44px] sm:min-h-0"
          onClick={onNext}
          disabled={busy || page >= shownTotalPages}
        >
          次へ
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
