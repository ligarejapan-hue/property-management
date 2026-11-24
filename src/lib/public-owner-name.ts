/**
 * 所有者の名前が自治体・国か(2026-11-24 発注者承認)。当たる所有者は DM 送付不可
 * (「業者と同じ名前の所有者=DM 送付不可」と同じ扱い・dm-batch/agent-name-exclusion.ts)。
 *
 * そろえ方: NFKC(全角/半角・（）→())→ 空白を全部除く。そろえた名前の**全体**が次のどれかなら自治体・国:
 *   - 都道府県だけ: 東京都|北海道|京都府|大阪府|(2〜3字)県
 *   - 都道府県+市区町村: 都道府県 + (1〜6字) + 市|区|町|村
 *   - 都道府県なしの市・区: (1〜6字) + 市|区
 *     ⚠町・村だけは見ない(木村・中村のような名字とぶつかる)
 *   - 国: 国 | 国(…) | 財務省・国土交通省ほかの省
 *
 * ⚠判定の正本はこのファイルの PUBLIC_OWNER_NAME_PATTERN 1つ。JS(isPublicOwnerName)と
 *   SQL(publicOwnerNameSql=Postgres の `~`)の両方が同じ文字列を使う。両方の結果が同じことは
 *   __tests__/public-owner-name.test.ts(JS)と dm-batch/__tests__/agent-name-exclusion-db.test.ts
 *   (本物の Postgres・同じ表 PUBLIC_OWNER_NAME_CASES)で確かめる。
 *   空白: JS は \s(u フラグ)・SQL は \s。NFKC で全角空白・NBSP は半角の空白になるので、どちらでも消える。
 *   `.` は JS は u フラグで1字(符号位置)・Postgres(UTF8)も1字。
 * ⚠知っている誤判定: 名前が「…市」で終わる方(例: 〇〇善市)は都道府県なしの市に当たる(発注者承認の決まりのまま)。
 */

import { Prisma } from "@/generated/prisma";

const PREFECTURE = "(?:東京都|北海道|京都府|大阪府|.{2,3}県)";

const MINISTRIES = [
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
];

/** そろえた名前の全体に当てる正規表現(JS と Postgres の両方で同じ意味になる書き方だけを使う)。 */
export const PUBLIC_OWNER_NAME_PATTERN = `^(?:${[
  PREFECTURE,
  `${PREFECTURE}.{1,6}(?:市|区|町|村)`,
  ".{1,6}(?:市|区)",
  "国",
  "国\\(.+\\)",
  ...MINISTRIES,
].join("|")})$`;

const PUBLIC_OWNER_NAME_RE = new RegExp(PUBLIC_OWNER_NAME_PATTERN, "u");

/** 名前のそろえ方(NFKC → 空白を全部除く)。 */
export function normalizePublicOwnerName(name: string | null | undefined): string {
  return (name ?? "").normalize("NFKC").replace(/\s+/gu, "");
}

/** 所有者の名前が自治体・国か(空は当たらない)。 */
export function isPublicOwnerName(name: string | null | undefined): boolean {
  const key = normalizePublicOwnerName(name);
  return key !== "" && PUBLIC_OWNER_NAME_RE.test(key);
}

/** isPublicOwnerName と同じ判定の SQL の式(真偽値)。column は名前の列。 */
export function publicOwnerNameSql(column: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(regexp_replace(normalize(coalesce(${column}, ''), NFKC), '\\s+', '', 'g') ~ ${PUBLIC_OWNER_NAME_PATTERN})`;
}

/**
 * JS と SQL の両方に当てる例の表(架空の名前だけ・地名は一般の市区町村名)。
 * true=自治体・国として外す / false=外さない。
 */
export const PUBLIC_OWNER_NAME_CASES: ReadonlyArray<readonly [string, boolean]> = [
  ["東京都", true],
  ["北海道", true],
  ["京都府", true],
  ["大阪府", true],
  ["神奈川県", true],
  ["千葉県", true],
  ["東京都世田谷区", true],
  ["東京都　世田谷区", true],
  ["神奈川県横浜市", true],
  ["北海道札幌市中央区", true],
  ["長野県下伊那郡阿智村", true],
  ["埼玉県比企郡小川町", true],
  ["世田谷区", true],
  ["横浜市", true],
  ["国", true],
  ["国（財務省）", true],
  ["国(国土交通省)", true],
  ["財務省", true],
  ["国土交通省", true],
  ["防衛省", true],
  ["木村", false],
  ["中村太郎", false],
  ["田中町子", false],
  ["株式会社大阪府", false],
  ["世田谷区役所前ビル株式会社", false],
  ["東京都住宅供給公社", false],
  ["国分太郎", false],
  ["大阪府民株式会社", false],
  ["佐藤 花子", false],
  ["", false],
  ["　", false],
];
