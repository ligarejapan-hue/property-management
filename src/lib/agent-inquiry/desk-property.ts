import { AD_MEDIA, type AdMediumKey, type AdValueKey } from "./constants";

// 漢数字(大字 壱弐参… と 廿・卅 も含む=NFKC では算用数字にならない・@codex #454 R10)。
const KANJI_NUM = "〇一二三四五六七八九十百千零壱弐参肆伍陸漆捌玖拾佰阡萬万廿卅";
/**
 * 数字が読めない形(ローマ数字など)でも、番地の印(番地/番/号)があればその手前で切る(安全側)。
 * 印の直前に続く英数字・漢数字もいっしょに落とす。「〇番町」は町名なので印として扱わない。
 */
const HOUSE_MARK = /番地|番(?!町)|号/;
const NUMBER_LIKE = new RegExp(`[0-9A-Za-z${KANJI_NUM}]`);
function houseMarkStart(rest: string): number {
  const m = HOUSE_MARK.exec(rest);
  if (!m) return -1;
  let i = m.index;
  while (i > 0 && NUMBER_LIKE.test(rest[i - 1])) i--;
  return i;
}
const PREFECTURE = /^(東京都|北海道|(?:京都|大阪)府|.{2,3}?県)/;
/**
 * 市区町村より後ろで最初に出る数字(算用数字・漢数字)。数字の連なりは切れ目なく1つとして扱い、
 * 「〇番町」(千代田区の番町は町名)だけは数字として扱わない。
 */
const NUMBER_RUN = new RegExp(`[0-9]+|(?<![${KANJI_NUM}])[${KANJI_NUM}]+(?![${KANJI_NUM}]|番町)`);

/** 市区町村名の終わり(都道府県の後で最初の「市」か「区」、無ければ「郡」の後の「町/村」)。 */
function municipalityEnd(a: string): number {
  const pref = a.match(PREFECTURE)?.[0].length ?? 0;
  const body = a.slice(pref);
  const shiku = body.search(/[市区]/);
  if (shiku !== -1) return pref + shiku + 1;
  const gun = body.indexOf("郡");
  if (gun === -1) return pref;
  const chouson = body.slice(gun + 1).search(/[町村]/);
  return pref + gun + 1 + (chouson === -1 ? 0 : chouson + 1);
}

/**
 * 所在地を町名(丁目)までにする(設計 §4=受付の窓では番地以降を見せない)。
 * 現地スタッフにも見せる値なので**安全側に倒す**: 市区町村より後ろは、最初に数字が出たところで切る
 * (漢数字の番地・建物名が続けて付いた形も漏らさない・レビュー Important 1/@codex #454 P1×2)。
 * その数字の直後が「丁目」ならそこまで残す。数字を含む町名(一条通 など)は町名が短くなるが、番地を
 * 見せるよりまし。市区町村名の数字(四日市市・三鷹市・十日町市)は切らない。
 */
export function townOnly(address: string): string {
  const a = address.normalize("NFKC").trim();
  const start = municipalityEnd(a);
  const rest = a.slice(start);
  const m = NUMBER_RUN.exec(rest);
  const mark = houseMarkStart(rest);
  if (m && (mark === -1 || m.index <= mark)) {
    const afterRun = m.index + m[0].length;
    if (rest.startsWith("丁目", afterRun)) return a.slice(0, start + afterRun + 2);
  }
  const cuts = [m?.index ?? -1, mark].filter((i) => i >= 0);
  if (cuts.length === 0) return a;
  return a.slice(0, start + Math.min(...cuts)).trim();
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
