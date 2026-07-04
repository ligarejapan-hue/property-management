"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Upload, FileText, Files } from "lucide-react";
import { IMPORT_TYPE_LABELS } from "@/lib/import-labels";

/**
 * 取込画面の入口統合コンポーネント。
 *
 * `/import`、`/import/registry-pdf`、`/import/registry-dm` の各ページ先頭に表示し、
 * 「受付帳CSV」「謄本PDF」「登記DM取込」の3タブを横並びで表示する。
 *
 * - 内部ロジック・APIは既存ページ側そのまま（このコンポーネントは導線のみ）
 * - 既存URLは温存（既存リンク・ブックマーク互換）
 * - 「いまどのモードか」を視覚化し、相互行き来を1クリックで可能にする
 */

const ITEMS: { href: string; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { href: "/import", label: IMPORT_TYPE_LABELS.property_csv, icon: Upload },
  { href: "/import/registry-pdf", label: IMPORT_TYPE_LABELS.registry_pdf, icon: FileText },
  { href: "/import/registry-dm", label: "登記DM取込", icon: Files },
];

export default function ImportSwitcher() {
  const pathname = usePathname();

  const isActive = (href: string) => {
    // /import は /import/* と区別が必要（exact match）
    if (href === "/import") return pathname === "/import";
    return pathname === href || pathname.startsWith(href + "/");
  };

  return (
    <nav
      aria-label="取込モード切替"
      className="mb-6 flex flex-wrap items-center gap-1 border-b border-gray-200 dark:border-gray-800"
    >
      {ITEMS.map((it) => {
        const Icon = it.icon;
        const active = isActive(it.href);
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
