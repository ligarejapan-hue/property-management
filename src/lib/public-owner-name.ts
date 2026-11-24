/**
 * 所有者の名前が自治体・国か(2026-11-24 発注者承認)。当たる所有者は DM 送付不可
 * (「業者と同じ名前の所有者=DM 送付不可」と同じ扱い・dm-batch/agent-name-exclusion.ts)。
 *
 * そろえ方: NFKC(全角/半角・（）→())→ 空白を全部除く。そろえた名前の**全体**が次のどれかなら自治体・国:
 *   - 都道府県だけ(47都道府県。名前は公式の市区町村の一覧の頭から取る=「〇〇県」の当て推量はしない)
 *   - 公式の市区町村の一覧(reverse-geocode/municipalities.ts の GSI_MUNICIPALITIES=国土地理院・
 *     「都道府県名+市区町村名」1919件・政令市の区を含む)の値そのもの(例: 東京都世田谷区・北海道札幌市中央区)
 *   - その値から都道府県を除いた部分のうち、市・区で終わるもの(例: 世田谷区・札幌市・札幌市中央区)
 *     ⚠都道府県の付かない町・村は当てない(木村・中村のような名字とぶつかる・発注者判断)
 *   - 国: 国 | 国(…) | 財務省・国土交通省ほかの省
 *   一覧に無い名前(例: 〇〇善市 のような「市」で終わる人の名前・存在しない市)は当てない。
 *
 * ⚠判定の正本はこのファイルの PUBLIC_OWNER_NAMES(一覧から作る名前の集合・読み込み時に1回だけ作る)と
 *   STATE_OWNER_NAME_PATTERN(国(…) の形だけの小さな正規表現)。JS(isPublicOwnerName)と
 *   SQL(publicOwnerNameSql=`= ANY(…::text[])` と `~`)の両方が同じ値を使う。両方の結果が同じことは
 *   __tests__/public-owner-name.test.ts(JS)と dm-batch/__tests__/agent-name-exclusion-db.test.ts
 *   (本物の Postgres・同じ表 PUBLIC_OWNER_NAME_CASES)で確かめる。
 *   空白: JS は \s(u フラグ)・SQL は \s。NFKC で全角空白・NBSP は半角の空白になるので、どちらでも消える。
 * ⚠表記ゆれ(ケ/ヶ・旧字体など)はそろえない=一覧と同じ書き方の名前だけが当たる。
 */

import { Prisma } from "@/generated/prisma";
import { GSI_MUNICIPALITIES } from "@/lib/reverse-geocode/municipalities";

/** 名前のそろえ方(NFKC → 空白を全部除く)。 */
export function normalizePublicOwnerName(name: string | null | undefined): string {
  return (name ?? "").normalize("NFKC").replace(/\s+/gu, "");
}

// 1府11省+土地を持つことの多い庁(2026-11-24 @codex #781: 外務省が抜けていた)
const MINISTRIES = [
  "内閣府",
  "外務省",
  "財務省",
  "国土交通省",
  "農林水産省",
  "防衛省",
  "文部科学省",
  "厚生労働省",
  "総務省",
  "法務省",
  "経済産業省",
  "環境省",
  "復興庁",
  "デジタル庁",
  "宮内庁",
  "林野庁",
  "水産庁",
  "国税庁",
  "文化庁",
  "気象庁",
  "海上保安庁",
];

/** 一覧の値の頭の都道府県(県は2〜3字+県。短い方から当てる=「神奈川県」も取れる)。 */
const PREFECTURE_PREFIX_RE = /^(東京都|北海道|京都府|大阪府|.{2,3}?県)(.+)$/u;

function buildPublicOwnerNames(): { prefectures: Set<string>; names: Set<string> } {
  const prefectures = new Set<string>();
  const names = new Set<string>(["国", ...MINISTRIES]);
  for (const raw of Object.values(GSI_MUNICIPALITIES)) {
    const full = normalizePublicOwnerName(raw);
    const m = PREFECTURE_PREFIX_RE.exec(full);
    if (!m) continue;
    const [, prefecture, municipality] = m;
    prefectures.add(prefecture);
    names.add(prefecture);
    names.add(full);
    // 都道府県なしは市・区だけ(町・村は名字とぶつかる)
    if (/[市区]$/u.test(municipality)) names.add(municipality);
  }
  return { prefectures, names };
}

const BUILT = buildPublicOwnerNames();

/** 47都道府県の名前(一覧の頭から取ったもの)。 */
export const PREFECTURE_NAMES: ReadonlySet<string> = BUILT.prefectures;

/** 自治体・国として当てる名前の集合(そろえたあとの名前と完全に同じときだけ当たる)。 */
export const PUBLIC_OWNER_NAMES: ReadonlySet<string> = BUILT.names;

/** SQL に渡す配列(並びを決めておく)。 */
const PUBLIC_OWNER_NAME_LIST: string[] = [...BUILT.names].sort();

/** 国(…) の形(例: 国(財務省))。JS と Postgres の両方で同じ意味になる書き方だけを使う。 */
export const STATE_OWNER_NAME_PATTERN = "^国\\(.+\\)$";

const STATE_OWNER_NAME_RE = new RegExp(STATE_OWNER_NAME_PATTERN, "u");

/** 所有者の名前が自治体・国か(空は当たらない)。 */
export function isPublicOwnerName(name: string | null | undefined): boolean {
  const key = normalizePublicOwnerName(name);
  return key !== "" && (PUBLIC_OWNER_NAMES.has(key) || STATE_OWNER_NAME_RE.test(key));
}

/** isPublicOwnerName と同じ判定の SQL の式(真偽値)。column は名前の列。 */
export function publicOwnerNameSql(column: Prisma.Sql): Prisma.Sql {
  const key = Prisma.sql`regexp_replace(normalize(coalesce(${column}, ''), NFKC), '\\s+', '', 'g')`;
  return Prisma.sql`(${key} = ANY(${PUBLIC_OWNER_NAME_LIST}::text[]) OR ${key} ~ ${STATE_OWNER_NAME_PATTERN})`;
}

/**
 * JS と SQL の両方に当てる例の表(架空の名前だけ・地名は公式の一覧にある市区町村名)。
 * true=自治体・国として外す / false=外さない。
 */
export const PUBLIC_OWNER_NAME_CASES: ReadonlyArray<readonly [string, boolean]> = [
  ["東京都", true],
  ["北海道", true],
  ["京都府", true],
  ["大阪府", true],
  ["神奈川県", true],
  ["外務省", true],
  ["内閣府", true],
  ["林野庁", true],
  ["外務省前ビル株式会社", false],
  ["千葉県", true],
  ["東京都世田谷区", true],
  ["東京都　世田谷区", true],
  ["神奈川県横浜市", true],
  ["北海道札幌市中央区", true],
  ["東京都奥多摩町", true],
  ["世田谷区", true],
  ["横浜市", true],
  ["札幌市", true],
  ["札幌市中央区", true],
  ["府中市", true],
  ["国", true],
  ["国（財務省）", true],
  ["国(国土交通省)", true],
  ["財務省", true],
  ["国土交通省", true],
  ["防衛省", true],
  ["奥多摩町", false],
  ["存在しない市", false],
  ["山田善市", false],
  ["善市", false],
  ["田中区男", false],
  ["木村", false],
  ["中村太郎", false],
  ["田中町子", false],
  ["株式会社大阪府", false],
  ["世田谷区役所前ビル株式会社", false],
  ["東京都住宅供給公社", false],
  ["国分太郎", false],
  ["大阪府民株式会社", false],
  ["架空県", false],
  ["佐藤 花子", false],
  ["", false],
  ["　", false],
];
