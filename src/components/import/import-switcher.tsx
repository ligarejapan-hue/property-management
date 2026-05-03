"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Upload, Users2, FileText } from "lucide-react";
import { IMPORT_TYPE_LABELS } from "@/lib/import-labels";

/**
 * 取込画面の入口統合コンポーネント。
 *
 * `/import`、`/import/owners`、`/import/registry-pdf` の各ページ先頭に表示し、
 * 「物件CSV」「所有者CSV」「謄本PDF」の3モードを横タブとして並べる。
 *
 * - 内部ロジック・APIは既存ページ側そのまま（このコンポーネントは導線のみ）
 * - 既存URLは温存（既存リンク・ブックマーク互換）
 * - 「いまどのモードか」を視覚化し、相互行き来を1クリックで可能にする
 */

const ITEMS: { href: string; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { href: "/import", label: IMPORT_TYPE_LABELS.property_csv, icon: Upload },
  { href: "/import/owners", label: IMPORT_TYPE_LABELS.owner_csv, icon: Users2 },
  { href: "/import/registry-pdf", label: IMPORT_TYPE_LABELS.registry_pdf, icon: FileText },
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
      className="mb-6 flex flex-wrap items-center gap-1 border-b border-gray-200"
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
                ? "border-blue-600 text-blue-700"
                : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
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
