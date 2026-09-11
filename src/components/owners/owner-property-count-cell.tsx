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
  /**
   * 0件のときの見た目。指定が無ければ通常色。
   *
   * P2 (#139 fallout の再発): この色は「件数が0件である」というデータの主張で
   * あって、「リンクが無い」というビューアの事情の主張ではない。
   * link.kind === "none" は「0件」と「property:read が無い」の両方で起きうる
   * ため、キーを link.kind ではなく count 自体に取る(下記参照)。
   */
  zeroClassName?: string;
}) {
  const link = resolveOwnerPropertyLink({
    ownerId,
    propertyOwnerCount: count,
    singlePropertyId,
    propertyLinkAvailable,
  });

  if (link.kind === "none") {
    // 橙色(zeroClassName)は「0件だから削除候補」という所有者補正画面の意味を
    // 背負っている。count <= 0 のときだけ橙にする。count > 0 なのにリンクが
    // 無い(property:read 不足など)場合は、リンクの下線・色だけを外した通常の
    // 文字色で描く(＝リンクがあったときと同じ色から下線と青だけを引いたもの)。
    // link.kind === "none" をそのまま橙の条件にしない(件数の主張とビューアの
    // 事情の主張を混ぜない)。
    const className =
      count <= 0
        ? (zeroClassName ?? "text-gray-700 dark:text-gray-200")
        : "text-gray-700 dark:text-gray-200";
    return <span className={className}>{count}</span>;
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
