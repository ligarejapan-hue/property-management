import { normalizeRealEstateNumber } from "@/lib/address-normalizer";
import { parcelNumberKey, readExtraParcels } from "@/lib/property-parcels";
import type { RegistrySide } from "./crosscheck";

/**
 * 2筆以上・2棟以上の物件で、どの筆(棟)の謄本が無いかを見る(2026-11-05 発注者 案A 2回目)。
 * ほかの土地・建物を足していない物件は今までどおり「土地・建物の種類ごとに1通あるか」だけ(ここでは何も見ない)。
 * ⚠Prisma を読まない(純関数)。
 */

/** 謄本が要る筆(棟)。label は画面に出す文字(「土地 1番2」)。 */
export interface ExpectedParcel {
  side: RegistrySide;
  number: string;
  realEstateNumber: string | null;
  label: string;
}

/** 読めた全部事項の、筆(棟)を見分ける値。 */
export interface CertificateParcel {
  side: RegistrySide;
  number: string | null;
  realEstateNumber: string | null;
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
    out.push({ side, number: n, realEstateNumber, label: `${side} ${location ? `${location} ` : ""}${n}` });
  };
  add("土地", p.lotNumber, null, null);
  add("建物", p.buildingNumber, null, null);
  for (const x of extras) add(x.kind === "land" ? "土地" : "建物", x.number, x.realEstateNumber, x.location);
  return out;
}

/** その筆(棟)の謄本か。不動産番号が両方にあれば不動産番号で、無ければ地番・家屋番号で比べる。 */
function covers(c: CertificateParcel, p: ExpectedParcel): boolean {
  if (c.side !== p.side) return false;
  const a = reKey(c.realEstateNumber);
  const b = reKey(p.realEstateNumber);
  if (a && b) return a === b;
  const n = parcelNumberKey(c.number);
  return !!n && n === parcelNumberKey(p.number);
}

/**
 * 謄本が無い筆(棟)の文字。
 * unplaced=番号を読めずどの筆か分からない全部事項がある(抜けを「無い」と言い切れない)。
 */
export function parcelCoverage(expected: ExpectedParcel[], certs: CertificateParcel[]): { missing: string[]; unplaced: boolean } {
  if (!expected.length) return { missing: [], unplaced: false };
  // 地番・家屋番号を読めず、不動産番号でもどの筆か決まらない全部事項。
  const unplaced = certs.some((c) => !parcelNumberKey(c.number) && !expected.some((p) => covers(c, p)));
  return { missing: expected.filter((p) => !certs.some((c) => covers(c, p))).map((p) => p.label), unplaced };
}
