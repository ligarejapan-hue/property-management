import { normalizeRealEstateNumber } from "@/lib/address-normalizer";
import { parcelNumberKey, pickParcelByLocation, readExtraParcels } from "@/lib/property-parcels";
import type { RegistrySide } from "./crosscheck";

/**
 * 2筆以上・2棟以上の物件で、どの筆(棟)の謄本が無いかを見る(2026-11-05 発注者 案A 2回目)。
 * ほかの土地・建物を足していない物件は今までどおり「土地・建物の種類ごとに1通あるか」だけ(ここでは何も見ない)。
 * ⚠Prisma を読まない(純関数)。
 */

/** 謄本が要る筆(棟)。label は画面に出す文字(「土地 1番2」)。location は空=物件の住所と同じ。 */
export interface ExpectedParcel {
  side: RegistrySide;
  number: string;
  realEstateNumber: string | null;
  location: string | null;
  label: string;
}

/**
 * 読めた全部事項の、筆(棟)を見分ける値。
 * ⚠number は表の欄だけを読む registryIdentityOf で(parseRegistryText は「1番1の2」を「1番1」に切る・@codex P2)。
 */
export interface CertificateParcel {
  side: RegistrySide;
  number: string | null;
  realEstateNumber: string | null;
  /** 謄本の所在(同じ番号の筆を見分けるのに使う)。 */
  address: string | null;
}

export { parcelNumberKey };

const reKey = (v: string | null | undefined) => (v ? normalizeRealEstateNumber(v) || null : null);

/**
 * 謄本が要る筆(棟)の一覧。ほかの土地・建物が無ければ空(=筆ごとには見ない)。
 * 1筆目・1棟目は物件の地番・家屋番号。⚠物件の不動産番号はどの筆のものか分からないので使わない。
 */
export function expectedParcels(
  p: { lotNumber: string | null; buildingNumber: string | null; extraParcels: unknown },
  required: readonly RegistrySide[],
): ExpectedParcel[] {
  const extras = readExtraParcels(p.extraParcels);
  if (!extras.length) return [];
  const out: ExpectedParcel[] = [];
  const add = (side: RegistrySide, number: string | null | undefined, realEstateNumber: string | null, location: string | null) => {
    const n = number?.trim();
    if (!n || !required.includes(side)) return;
    out.push({ side, number: n, realEstateNumber, location: location?.trim() || null, label: `${side} ${location ? `${location} ` : ""}${n}` });
  };
  add("土地", p.lotNumber, null, null);
  add("建物", p.buildingNumber, null, null);
  for (const x of extras) add(x.kind === "land" ? "土地" : "建物", x.number, x.realEstateNumber, x.location);
  return out;
}

/**
 * 全部事項1通が、どの筆(棟)のものか。決められなければ null。
 * 不動産番号が両方にあって一致すればそれ。無ければ地番・家屋番号で、同じ番号が2つ以上なら所在で決める(@codex P1)。
 * ⚠1通で2つの筆を満たしたことにしない。
 */
function placeOf(c: CertificateParcel, expected: ExpectedParcel[]): ExpectedParcel | null {
  const re = reKey(c.realEstateNumber);
  const sameSide = expected.filter((p) => p.side === c.side);
  const byRe = re ? sameSide.filter((p) => reKey(p.realEstateNumber) === re) : [];
  if (byRe.length === 1) return byRe[0];
  const n = parcelNumberKey(c.number);
  if (!n) return null;
  // 不動産番号が両方にあって違う筆は、番号が同じでも別の筆。
  const byNumber = sameSide.filter((p) => parcelNumberKey(p.number) === n && !(re && reKey(p.realEstateNumber) && reKey(p.realEstateNumber) !== re));
  return pickParcelByLocation(byNumber, c.address);
}

/**
 * 謄本が無い筆(棟)の文字。
 * unplaced=番号を読めない・同じ番号の筆を所在でも決められないなど、どの筆か分からない全部事項がある
 * (抜けを「無い」と言い切れない)。
 */
export function parcelCoverage(expected: ExpectedParcel[], certs: CertificateParcel[]): { missing: string[]; unplaced: boolean } {
  if (!expected.length) return { missing: [], unplaced: false };
  const covered = new Set<ExpectedParcel>();
  let unplaced = false;
  for (const c of certs) {
    const p = placeOf(c, expected);
    if (p) covered.add(p);
    // 番号が読めて、どの筆とも合わない謄本(物件と関係ない筆)は抜けの判定に使わない。
    else if (!parcelNumberKey(c.number) || expected.filter((x) => x.side === c.side && parcelNumberKey(x.number) === parcelNumberKey(c.number)).length > 1) unplaced = true;
  }
  return { missing: expected.filter((p) => !covered.has(p)).map((p) => p.label), unplaced };
}
