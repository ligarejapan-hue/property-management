"use client";

import Link from "next/link";
import { resolveOwnerPropertyLink } from "@/lib/owner-property-link";

/** API が行ごとに返す、物件へ飛ぶリンクの材料(owner-property-link-data.ts と同じ形)。 */
export interface OwnerPropertyLinkProp {
  count: number;
  singlePropertyId: string | null;
  hasReachableProperty: boolean;
  available: boolean;
}

/** 物件へ飛ぶリンクの文字(純関数)。リンクにしないときは href が null。 */
export function ownerPropertyOpenLabel(
  ownerId: string,
  link: OwnerPropertyLinkProp | undefined,
): { href: string | null; text: string | null } {
  if (!link) return { href: null, text: null };
  const resolved = resolveOwnerPropertyLink({
    ownerId,
    propertyOwnerCount: link.count,
    singlePropertyId: link.singlePropertyId,
    propertyLinkAvailable: link.available,
    hasReachableProperty: link.hasReachableProperty,
  });
  if (resolved.kind === "single") return { href: resolved.href, text: "物件を開く" };
  if (resolved.kind === "many") return { href: resolved.href, text: `物件を見る(${link.count}件)` };
  // つながっている物件が無い所有者は、そのことを出す(押せる所が無い理由が分かるように)。
  if (link.count <= 0) return { href: null, text: "物件なし" };
  // 物件はあるが、この人には開けない(物件の閲覧権限が無い・担当外)。何も出さない。
  return { href: null, text: null };
}

/**
 * 所有者補正候補の行から、その所有者の物件へ飛ぶリンク(2026-11-16)。
 * 物件が1件ならその物件の画面へ、2件以上ならその所有者で絞り込んだ物件一覧へ。
 * 行き先の決め方は resolveOwnerPropertyLink(件数のリンクと同じ決まり)。
 */
export function OwnerPropertyOpenLink({
  ownerId,
  link,
  className,
}: {
  ownerId: string;
  link: OwnerPropertyLinkProp | undefined;
  className?: string;
}) {
  const { href, text } = ownerPropertyOpenLabel(ownerId, link);
  if (text === null) return null;
  if (href === null) {
    return <span className="whitespace-nowrap text-xs text-gray-400 dark:text-gray-500">{text}</span>;
  }
  return (
    <Link
      href={href}
      className={
        className ??
        "whitespace-nowrap rounded-md border border-blue-300 dark:border-blue-800 px-2 py-1 text-center text-xs text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950"
      }
    >
      {text}
    </Link>
  );
}
