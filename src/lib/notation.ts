/**
 * 地名のケ・ヶ・がと、全角・半角の数字の揺れの扱い(2026-11-02 発注者「井土ヶ谷のケに揺れ」「数字を半角で統一」)。
 *
 * - 検索: どの書き方でも見つかるように、書き方の候補を OR で探す。
 * - 保存: 住所・番号の数字を半角にする(prisma.ts の拡張から呼ぶ=書き込みの経路を問わない)。
 *
 * ⚠**ケ・ヶは保存の字を変えない**。正しい字は地名ごとに違う(茅ヶ崎市・鎌ケ谷市)ので一律には直せない(発注者決定)。
 * ⚠今ある全角のデータは書き換えない(発注者決定=後回し)。書き換えるまで全角と半角が混ざるので、検索は両方を探す。
 * ⚠所有者の氏名・名簿・備考・ファイル名・履歴は対象にしない。
 */
import { toHalfWidthDigits } from "@/lib/registry-fetch/chiban-input";

const KE_LETTERS = ["ケ", "ヶ", "が"];
/** 地名の中のケの音。⚠漢字の後ろだけ(ケアハウス・ながの を別の語にしない)。 */
const KE_IN_PLACE_NAME = /(?<=[一-龥々])[ケヶヵが]/g;
/** 候補が増えすぎないよう、3つ目からは変えない。 */
const MAX_KE = 2;

const toFullWidthDigits = (s: string) => s.replace(/[0-9]/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0xfee0));

/**
 * 数字の幅の候補。⚠数字だけ変えた形も探す: 保存は数字だけ半角にするので「１－２」は「1－2」で入る(@codex)。
 * 区切りごと変えた形は、もとから半角や全角でそろって入っている行のため。
 */
function widthVariants(q: string): string[] {
  if (!/[0-9０-９]/.test(q)) return [q];
  const half = toHalfWidthDigits(q);
  const full = toFullWidthDigits(half);
  return [q, half, full, half.replace(/－/g, "-"), full.replace(/-/g, "－")];
}

function keVariants(q: string): string[] {
  const positions = [...q.matchAll(KE_IN_PLACE_NAME)].map((m) => m.index).slice(0, MAX_KE);
  let out = [q];
  for (const at of positions) {
    // ⚠打った字も必ず残す(「三ヵ月ビル」が元の書き方で見つからなくなる・@codex)。
    out = out.flatMap((s) => [...new Set([q[at], ...KE_LETTERS])].map((k) => s.slice(0, at) + k + s.slice(at + 1)));
  }
  return out;
}

/** 検索語の書き方の候補(元の語を含む・重複なし)。 */
export function searchVariants(q: string): string[] {
  return [...new Set(widthVariants(q).flatMap(keVariants))];
}

/** Prisma の OR に並べる条件。 */
export function containsVariants<F extends string>(
  field: F,
  q: string,
  mode?: "insensitive",
): Record<F, { contains: string; mode?: "insensitive" }>[] {
  return searchVariants(q).map(
    (v) => ({ [field]: mode ? { contains: v, mode } : { contains: v } }) as Record<F, { contains: string; mode?: "insensitive" }>,
  );
}

/** 保存のときに数字を半角にする項目。 */
const HALF_WIDTH_FIELDS: Record<string, readonly string[]> = {
  property: ["address", "lotNumber", "buildingNumber", "buildingName", "roomNo"],
  owner: ["address", "currentAddress"],
  building: ["name", "address", "lotNumber"],
  dealParty: ["address"],
  agent: ["address"],
};
const WRITE_OPERATIONS = new Set(["create", "createMany", "createManyAndReturn", "update", "updateMany", "updateManyAndReturn", "upsert"]);

/**
 * 実際に保存される値。⚠変更履歴の比較はこの形で行う(「１丁目」のまま保存すると「1丁目」に変わるので記録する。
 * 半角で入っている行へ全角で打っても変わらないので記録しない・@codex)。
 */
export function savedTextValue(model: string, field: string, value: string): string {
  return HALF_WIDTH_FIELDS[model]?.includes(field) ? toHalfWidthDigits(value) : value;
}

/**
 * 画面に出すときだけ数字を半角にする(2026-11-07 発注者「進めて」)。保存のときと同じ変え方=数字だけ。
 * ⚠データは書き換えない(今ある全角は残る)。⚠帳票・DM の宛名・販売図面・謄本には使わない(縦書きや原本の写しは元の字のまま)。
 * ⚠入力欄の値には使わない(打っていないのに変わったことになる)。
 */
export function displayHalfWidth<T extends string | null | undefined>(value: T): T {
  return (typeof value === "string" ? toHalfWidthDigits(value) : value) as T;
}

type Row = Record<string, unknown>;

function convertRow(row: Row, fields: readonly string[]): Row {
  const out: Row = { ...row };
  for (const f of fields) {
    const v = out[f];
    if (typeof v === "string") out[f] = toHalfWidthDigits(v);
    else if (v && typeof v === "object" && typeof (v as { set?: unknown }).set === "string") {
      out[f] = { ...v, set: toHalfWidthDigits((v as { set: string }).set) };
    }
  }
  return out;
}

const convertData = (data: unknown, fields: readonly string[]) =>
  Array.isArray(data) ? data.map((r) => convertRow(r as Row, fields)) : convertRow(data as Row, fields);

/** 書き込みの引数の数字を半角にする。⚠where は変えない(全角で入っている行を探せなくしない)。読み取りはそのまま返す。 */
export function halfWidthDigitsInWrite<A>(model: string, operation: string, args: A): A {
  const fields = HALF_WIDTH_FIELDS[model];
  if (!fields || !WRITE_OPERATIONS.has(operation)) return args;
  const a = args as Row;
  if (operation === "upsert") return { ...a, create: convertData(a.create, fields), update: convertData(a.update, fields) } as A;
  return { ...a, data: convertData(a.data, fields) } as A;
}
