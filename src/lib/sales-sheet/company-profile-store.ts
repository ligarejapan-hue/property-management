import prisma from "@/lib/prisma";
import { COMPANY_INFO } from "./company-info";

export type CompanyProfile = {
  nameJa: string;
  license: string;
  tel: string;
  fax: string;
  email: string;
  hp: string;
  address: string;
};

/** 解決後の会社情報の既定値（3キー削除後の COMPANY_INFO と同一）。 */
const DEFAULT: CompanyProfile = {
  nameJa: COMPANY_INFO.nameJa,
  license: COMPANY_INFO.license,
  tel: COMPANY_INFO.tel,
  fax: COMPANY_INFO.fax,
  email: COMPANY_INFO.email,
  hp: COMPANY_INFO.hp,
  address: COMPANY_INFO.address,
};

type Row = Partial<Record<keyof CompanyProfile, string | null | undefined>>;

function pick(v: string | null | undefined, fallback: string): string {
  const t = (v ?? "").trim();
  return t !== "" ? t : fallback;
}

/** DB行(or null)→解決済み会社情報。空/空白は既定へフォールバック（純関数）。 */
export function resolveCompanyProfile(row: Row | null): CompanyProfile {
  if (!row) return { ...DEFAULT };
  return {
    nameJa: pick(row.nameJa, DEFAULT.nameJa),
    license: pick(row.license, DEFAULT.license),
    tel: pick(row.tel, DEFAULT.tel),
    fax: pick(row.fax, DEFAULT.fax),
    email: pick(row.email, DEFAULT.email),
    hp: pick(row.hp, DEFAULT.hp),
    address: pick(row.address, DEFAULT.address),
  };
}

/** DBから会社情報を読み解決する。DBエラー時は既定へフォールバック（図面生成を止めない）。 */
export async function loadCompanyProfile(): Promise<CompanyProfile> {
  try {
    const row = await prisma.companyProfile.findUnique({ where: { id: "singleton" } });
    return resolveCompanyProfile(row);
  } catch {
    return { ...DEFAULT };
  }
}
