"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Upload, Files, ClipboardPaste, FileCheck } from "lucide-react";

/**
 * 取込画面の入口統合コンポーネント。
 *
 * `/import`、`/import/registry-pdf`、`/import/registry-dm`、`/import/paste` の各ページ先頭に表示し、
 * 「受付帳CSV」「謄本PDF」「取得済みPDFを一括添付」(旧 登記DM取込)「貼り付けて物件化」などのタブを横並びで表示する。
 *
 * - 内部ロジック・APIは既存ページ側そのまま（このコンポーネントは導線のみ）
 * - 既存URLは温存（既存リンク・ブックマーク互換）
 * - 「いまどのモードか」を視覚化し、相互行き来を1クリックで可能にする
 */

// 2026-10-28: 「受付帳CSV」「謄本PDF」のタブは「ファイルを入れる」1つに替えた(左メニューとそろえる・発注者決定)。
//   受付帳(/import)・謄本(/import/registry-pdf)の画面は「ファイルを入れる」から進んで開くので、
//   そこでは「ファイルを入れる」のタブを選ばれた形で出す(also)。
const ITEMS: {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  also?: readonly string[];
}[] = [
  { href: "/import/drop", label: "ファイルを入れる", icon: Upload, also: ["/import", "/import/registry-pdf"] },
  { href: "/import/registry-dm", label: "取得済みPDFを一括添付", icon: Files },
  { href: "/import/paste", label: "貼り付けて物件化", icon: ClipboardPaste },
  { href: "/import/report-inbox", label: "書類の受け取り箱", icon: FileCheck },
];

export default function ImportSwitcher() {
  const pathname = usePathname();

  const isActive = (it: (typeof ITEMS)[number]) => {
    // /import は /import/* と区別が必要（exact match）
    if (it.also?.includes(pathname)) return true;
    return pathname === it.href || pathname.startsWith(it.href + "/");
  };

  return (
    <nav
      aria-label="取込モード切替"
      className="mb-6 flex flex-wrap items-center gap-1 border-b border-gray-200 dark:border-gray-800"
    >
      {ITEMS.map((it) => {
        const Icon = it.icon;
        const active = isActive(it);
        return (
          <Link
            key={it.href}
            href={it.href}
            className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              active
                ? "border-indigo-600 dark:border-indigo-400 text-indigo-700 dark:text-indigo-400"
                : "border-transparent text-gray-500 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-600 hover:text-gray-700 dark:hover:text-gray-300"
            }`}
            aria-current={active ? "page" : undefined}
          >
            <Icon className="h-4 w-4" />
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}
