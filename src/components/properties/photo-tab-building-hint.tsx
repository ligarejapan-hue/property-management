import Link from "next/link";
import { Building2 } from "lucide-react";

/** 棟詳細ページの「棟写真」枠に付けるアンカーid（物件写真の案内リンクの飛び先） */
export const BUILDING_PHOTOS_ANCHOR = "building-photos";

/**
 * 物件写真タブ見出し下の案内文(常に出す・設計 §6.4)。
 * - 区分マンション・棟あり: 共用部・外観の写真を置く棟写真へのリンク
 * - 区分マンション・棟なし: 物件名を入れると棟につながる案内(+編集を開くボタン)
 * - それ以外: この物件の写真であることだけ
 */
export function PhotoTabBuildingHint({
  propertyType,
  building,
  onEditProperty,
}: {
  propertyType: string;
  building: { id: string; name: string } | null;
  onEditProperty?: () => void;
}) {
  const textClass = "mt-0.5 text-xs text-gray-500 dark:text-gray-400";
  if (propertyType === "apartment_unit" && building) {
    return (
      <p className={textClass}>
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
  if (propertyType === "apartment_unit") {
    return (
      <p className={textClass}>
        この物件単体の写真です。物件名(マンション名)を入れると棟につながり、共用部・外観の写真を部屋どうしで共有できます。
        {onEditProperty && (
          <button
            type="button"
            onClick={onEditProperty}
            className="ml-1 font-medium text-blue-600 underline hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
          >
            物件名を入れる
          </button>
        )}
      </p>
    );
  }
  return <p className={textClass}>この物件の写真です。</p>;
}
