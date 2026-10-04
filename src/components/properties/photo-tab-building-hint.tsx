import Link from "next/link";
import { Building2 } from "lucide-react";

/** 棟詳細ページの「棟写真」枠に付けるアンカーid（物件写真の案内リンクの飛び先） */
export const BUILDING_PHOTOS_ANCHOR = "building-photos";

/**
 * 物件写真タブ見出し下の案内文。
 * 棟に紐づく物件では、共用部・外観の写真を置く棟写真へ直接飛べるリンクを出す。
 * 棟が無い物件では棟写真の案内自体を出さない（飛び先が無いため）。
 */
export function PhotoTabBuildingHint({
  building,
}: {
  building: { id: string; name: string } | null;
}) {
  if (!building) {
    return (
      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
        この物件の写真です。
      </p>
    );
  }
  return (
    <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
      この物件単体の写真です。共用部・外観などの棟全体写真は
      <Link
        href={`/buildings/${building.id}#${BUILDING_PHOTOS_ANCHOR}`}
        className="mx-1 inline-flex items-center gap-0.5 font-medium text-blue-600 underline hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
      >
        <Building2 className="h-3.5 w-3.5" />
        {building.name || "棟の詳細"}の棟写真
      </Link>
      をご利用ください。
    </p>
  );
}
