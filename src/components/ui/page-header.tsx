/**
 * ページ見出し (UI一貫性 第2弾 ⑧・発注者承認 2026-08-23)。
 *
 * 背景: h1 の書式が10種類に増殖していた(実測)。以後、画面の題名は
 * この部品で「題名(text-2xl bold)+説明(小さくmuted)+右端の操作」に統一。
 * 戻る導線が要る詳細画面は back を渡す(BackLink=「← ◯◯へ戻る」)。
 */
import type { ReactNode } from "react";
import { BackLink } from "./back-link";

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** 右端に置く操作(新規作成ボタン等)。 */
  actions?: ReactNode;
  back?: { href: string; to: string };
  className?: string;
}

export function PageHeader({
  title,
  description,
  actions,
  back,
  className,
}: PageHeaderProps) {
  return (
    <div className={`mb-6${className ? ` ${className}` : ""}`}>
      {back && (
        <div className="mb-2">
          <BackLink href={back.href} to={back.to} />
        </div>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {title}
          </h1>
          {description !== undefined && (
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {description}
            </p>
          )}
        </div>
        {actions !== undefined && (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        )}
      </div>
    </div>
  );
}
