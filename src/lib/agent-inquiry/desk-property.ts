import { AD_MEDIA, type AdMediumKey, type AdValueKey } from "./constants";

const KANJI_NUM = "〇一二三四五六七八九十百千零";
/**
 * 番地の始まり: 算用数字、または漢数字の後に「番(番町は町名なので除く)/号/区切り(ー・-)/の」が続くところ。
 * 漢数字だけの町名(十日町・八王子・三番町)は切らない。迷う形(一の宮 など)は短く切る側に倒す
 * =番地を見せるより町名が短くなる方がまし(レビュー Important 1: 漢数字の番地が現地スタッフへ漏れていた)。
 */
const HOUSE_NUMBER_START = new RegExp(`[0-9]|[${KANJI_NUM}]+(?:番(?!町)|号|[ー\\-]|の)`);

/**
 * 所在地を町名(丁目)までにする(設計 §4=受付の窓では番地以降を見せない)。
 * 「丁目」があればそこまで。無ければ番地の始まりの手前まで。
 */
export function townOnly(address: string): string {
  const a = address.normalize("NFKC").trim();
  const chome = a.match(/^(.*?丁目)/);
  if (chome) return chome[1];
  const cut = a.search(HOUSE_NUMBER_START);
  return (cut === -1 ? a : a.slice(0, cut)).trim();
}

/**
 * 検索語の全角/半角のゆれを吸収する候補(レビュー Important 2)。DB の値は正規化していない
 * (登記由来の住所は全角が多い)ので、入力そのまま・半角・全角の3通りで探す。
 */
export function widthVariants(term: string): string[] {
  const half = term.normalize("NFKC");
  const full = half.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
  return [...new Set([term, half, full])];
}

/** DB から読む列=許可リストに必要なものだけ。 */
export const DESK_PROPERTY_SELECT = {
  id: true,
  propertyType: true,
  buildingName: true,
  roomNo: true,
  address: true,
  building: { select: { name: true } },
  adPermissions: { select: { medium: true, value: true } },
} as const;

export interface DeskProperty {
  id: string;
  name: string;
  roomNo: string | null;
  town: string;
  propertyType: string;
  adPermissions: Partial<Record<AdMediumKey, AdValueKey>>;
}
export const DESK_PROPERTY_KEYS = ["id", "name", "roomNo", "town", "propertyType", "adPermissions"] as const;

export interface DeskPropertyRow {
  id: string;
  propertyType: string;
  buildingName: string | null;
  roomNo: string | null;
  address: string;
  building: { name: string } | null;
  adPermissions: { medium: string; value: string }[];
}

/**
 * 受付の窓に返す物件の形(設計 §4・方針10)。現地スタッフにも全物件を見せるため、
 * 許可リストで組み立てる=行に何が混ざっていても(所有者・価格・地番など)外へ出さない。
 */
export function toDeskProperty(row: DeskPropertyRow): DeskProperty {
  const town = townOnly(row.address ?? "");
  const ads: Partial<Record<AdMediumKey, AdValueKey>> = {};
  for (const p of row.adPermissions ?? []) {
    if ((AD_MEDIA as readonly string[]).includes(p.medium)) ads[p.medium as AdMediumKey] = p.value as AdValueKey;
  }
  return {
    id: row.id,
    name: row.building?.name || row.buildingName || town,
    roomNo: row.roomNo ?? null,
    town,
    propertyType: row.propertyType,
    adPermissions: ads,
  };
}
