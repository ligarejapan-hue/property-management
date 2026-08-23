/**
 * 戻る導線 (UI一貫性 第2弾 ⑩・発注者承認 2026-08-23)。
 *
 * 背景: 「← 戻る」「〜に戻る」「一覧へ戻る」の3種が混在していた(実測)。
 * 以後、ページ間の戻る導線はこの部品で「← ◯◯へ戻る」に統一する
 * (行き先を必ず明記=どこへ戻るか押す前に分かる)。
 *
 * ⚠ウィザードの「前の手順へ」ボタン(step を戻すだけでページ遷移しない)は
 *   対象外。それはページ間導線ではなく手順内の操作。
 */
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export interface BackLinkProps {
  href: string;
  /** 行き先の名前(「◯◯へ戻る」の◯◯)。例: 物件一覧・棟一覧 */
  to: string;
  className?: string;
}

export function BackLink({ href, to, className }: BackLinkProps) {
  return (
    <Link
      href={href}
      className={`inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200${className ? ` ${className}` : ""}`}
    >
      <ArrowLeft className="h-4 w-4" />
      {to}へ戻る
    </Link>
  );
}
