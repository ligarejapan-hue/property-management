import { AD_MEDIA, type AdMediumKey, type AdValueKey } from "./constants";

/**
 * 所在地を町名(丁目)までにする(設計 §4=受付の窓では番地以降を見せない)。
 * 「丁目」があればそこまで。無ければ最初の数字か「〇番」の手前まで。
 */
export function townOnly(address: string): string {
  const a = address.normalize("NFKC").trim();
  const chome = a.match(/^(.*?丁目)/);
  if (chome) return chome[1];
  const cut = a.search(/[0-9]|[一二三四五六七八九十百]+番/);
  return (cut === -1 ? a : a.slice(0, cut)).trim();
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
