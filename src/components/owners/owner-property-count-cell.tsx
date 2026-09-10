"use client";

import Link from "next/link";
import { resolveOwnerPropertyLink } from "@/lib/owner-property-link";

/**
 * 所有者の「紐づき物件数」を、行き先のあるリンクとして描く。
 *
 * 0件のときはリンクにしない。1件ならその物件の基本情報へ、2件以上なら
 * その所有者で絞り込んだ物件一覧へ。分岐は resolveOwnerPropertyLink が決める。
 */
export function OwnerPropertyCountCell({
  ownerId,
  count,
  singlePropertyId,
  propertyLinkAvailable,
  zeroClassName,
}: {
  ownerId: string;
  count: number;
  singlePropertyId: string | null;
  /**
   * P2 (#139 fallout): セッションが property:read を持つか
   * (API summary.propertyLinkAvailable)。false ならリンクにせず件数だけ描く
   * (件数自体は非秘匿・今までどおり表示する)。
   */
  propertyLinkAvailable: boolean;
  /** 0件のときの見た目。指定が無ければ通常色。 */
  zeroClassName?: string;
}) {
  const link = resolveOwnerPropertyLink({
    ownerId,
    propertyOwnerCount: count,
    singlePropertyId,
    propertyLinkAvailable,
  });

  if (link.kind === "none") {
    return (
      <span className={zeroClassName ?? "text-gray-700 dark:text-gray-200"}>
        {count}
      </span>
    );
  }

  return (
    <Link
      href={link.href}
      title={
        link.kind === "single"
          ? "この物件の基本情報を開く"
          : "この所有者の物件を一覧で見る"
      }
      className="text-blue-700 underline underline-offset-2 hover:text-blue-900 dark:text-blue-300 dark:hover:text-blue-200"
    >
      {count}
    </Link>
  );
}
