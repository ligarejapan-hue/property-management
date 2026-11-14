/**
 * 取得した調査情報の用途地域・建蔽率・容積率を、物件の欄(販売図面に出る欄)へ写すときの中身を決める。
 *
 * 2026-11-14 発注者「調査情報は自動取得をするので確認済みボタンは不要」+「物件の欄は空欄のときだけ自動で写す」。
 * 以前は「確認済みにする」を押したときだけ、空でも上書きで写していた。
 * - 物件の欄が空(null・空白だけの文字)のものだけ写す。人や Excel が入れた値は上書きしない。
 * - 取れなかった項目(null・空白だけ)は写さない。
 * - 写すものが無ければ null(物件の行に書かない=版を上げない・編集中の人の保存を 409 にしない)。
 */

type Num = number | { toString(): string } | null | undefined;

export interface InvestigationFillSource {
  zoningDistrict: string | null | undefined;
  buildingCoverageRatio: Num;
  floorAreaRatio: Num;
}

export interface PropertyFillData {
  zoningDistrict?: string;
  buildingCoverageRatio?: number;
  floorAreaRatio?: number;
}

function text(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t ? t : null;
}

function num(v: Num): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v.toString());
  return Number.isFinite(n) ? n : null;
}

export function propertyFillFromInvestigation(
  current: InvestigationFillSource,
  fetched: InvestigationFillSource,
): PropertyFillData | null {
  const out: PropertyFillData = {};
  const z = text(fetched.zoningDistrict);
  if (text(current.zoningDistrict) === null && z !== null) out.zoningDistrict = z;
  const b = num(fetched.buildingCoverageRatio);
  if (num(current.buildingCoverageRatio) === null && b !== null) out.buildingCoverageRatio = b;
  const f = num(fetched.floorAreaRatio);
  if (num(current.floorAreaRatio) === null && f !== null) out.floorAreaRatio = f;
  return Object.keys(out).length > 0 ? out : null;
}
