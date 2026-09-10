/**
 * 所有者から物件へのリンク先を決める純関数。
 *
 * 画面(所有者補正候補・所有者詳細)は結果を表示するだけにし、分岐はここに集約する。
 * 3通りしかないが、**件数と物件IDが食い違う場合**を画面側で場当たりに扱うと
 * `/properties/undefined` のような壊れたリンクが出る。判定を1箇所に閉じ込める。
 *
 * href に載せてよいのは所有者ID・物件IDだけ。氏名/住所/法人番号/externalLinkKey は
 * URL に絶対に入れない(既存の明文ルール)。
 */

export type OwnerPropertyLink =
  | { kind: "none" }
  | { kind: "single"; href: string }
  | { kind: "many"; href: string };

export interface OwnerPropertyLinkInput {
  ownerId: string;
  propertyOwnerCount: number;
  /** 紐づきがちょうど1件のときの物件ID。分からなければ null。 */
  singlePropertyId: string | null;
}

/**
 * 所有者で絞り込んだ物件一覧への URL を1箇所で組み立てる。
 * `resolveOwnerPropertyLink` とページ側の直書きリンクの両方がこれを使う。
 * クエリパラメータ名を変えるときはここだけ直せばよい。
 */
export function ownerFilteredPropertyListHref(ownerId: string): string {
  return `/properties?ownerId=${encodeURIComponent(ownerId)}`;
}

export function resolveOwnerPropertyLink(
  input: OwnerPropertyLinkInput,
): OwnerPropertyLink {
  const { ownerId, propertyOwnerCount, singlePropertyId } = input;
  // ownerId が空だと `?ownerId=` になり、絞り込み無しの全件一覧を
  // 「この所有者の物件」として見せてしまう。リンクにしない。
  if (ownerId === "") return { kind: "none" };
  if (propertyOwnerCount <= 0) return { kind: "none" };
  if (propertyOwnerCount === 1 && singlePropertyId !== null) {
    return { kind: "single", href: `/properties/${singlePropertyId}` };
  }
  // 1件なのに物件IDが分からない場合もここに落とす(担当外で読めない等)。
  // 壊れたリンクを出すより、絞り込んだ一覧へ逃がす方が安全。
  return {
    kind: "many",
    href: ownerFilteredPropertyListHref(ownerId),
  };
}

/**
 * 紐づき物件が「ちょうど1件」のときだけ物件IDを返す。
 * 呼び出し側は `take: 2` で2件だけ読めば足りる(1件か2件以上かの判別に十分)。
 */
export function pickSinglePropertyId(
  rows: ReadonlyArray<{ propertyId: string }>,
): string | null {
  return rows.length === 1 ? rows[0].propertyId : null;
}
