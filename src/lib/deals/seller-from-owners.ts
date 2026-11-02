/**
 * 物件の所有者を取引の売主に入れる(2026-11-02 発注者「売主は物件の所有者情報を自動反映。違う場合は手作業で直す」)。
 * 物件から取引を作るときと、当事者タブのボタンで使う。
 *
 * ⚠足すだけ。入っている売主は書き換えない(手で直した内容を消さない)。
 * ⚠所有者情報の表示レベルで、そのまま見られる項目だけ(依頼文の差し込みと同じ決まり・一部表示の人の操作で伏せた値を広げない)。
 * ⚠住所は現住所があれば現住所(お客様に連絡がつく住所)。無ければ登記上の住所。
 */
import type { PermissionEntry } from "@/lib/api-helpers";
import { hasPermission, isMaskFreeLevel, resolveOwnerDisplayConfig } from "@/lib/permissions";
import { foldNameVariants } from "./crosscheck";
import { resolveCompanyProfile } from "@/lib/sales-sheet/company-profile-store";
import type { Prisma } from "@/generated/prisma";

export interface SellerAccess { name: boolean; address: boolean; phone: boolean }

export function sellerAccessOf(perms: PermissionEntry[]): SellerAccess {
  const canRead = hasPermission(perms, "owner", "read");
  const levels = resolveOwnerDisplayConfig(perms);
  return {
    name: canRead && isMaskFreeLevel(levels.name),
    address: canRead && isMaskFreeLevel(levels.address),
    phone: canRead && isMaskFreeLevel(levels.phone),
  };
}

export const SELLER_OWNER_SELECT = {
  name: true, phone: true, address: true, currentAddress: true, corporateNumber: true, companyRegistryNumber: true,
} as const;

export interface OwnerForSeller {
  name: string; phone: string | null; address: string | null; currentAddress: string | null;
  corporateNumber: string | null; companyRegistryNumber: string | null;
}

export interface SellerParty {
  role: "seller"; partyType: "individual" | "corporation"; name: string;
  address: string | null; phone: string | null; isSelf: false;
}

const CORPORATE_NAME = /株式会社|有限会社|合同会社|合資会社|合名会社|[(（][株有][)）]|一般社団法人|一般財団法人|公益社団法人|公益財団法人|医療法人|学校法人|宗教法人|社会福祉法人|特定非営利活動法人|NPO法人|ＮＰＯ法人|独立行政法人/;
/** 当事者の欄の上限(schemas.ts の partyFields と同じ)。 */
const MAX_NAME = 200;
const MAX_ADDRESS = 300;
const MAX_PHONE = 50;

const fit = (v: string | null | undefined, max: number): string | null => {
  const t = v?.trim();
  return t && t.length <= max ? t : null;
};

const sameCompany = (a: string, b: string) => {
  const key = (v: string) => foldNameVariants(v).replace(/\s/g, "");
  return key(a) === key(b);
};

/** 自社の名前の所有者を除く(自社の持ち物を売る取引に、自社を個人の売主として入れない)。純関数。 */
export function ownersExceptCompany<T extends { name: string }>(owners: T[], companyName: string): T[] {
  return owners.filter((o) => !sameCompany(o.name, companyName));
}

/** 足す売主を決める。純関数。`existingNames` はすでに入っている売主の氏名。 */
export function sellerPartiesFromOwners(owners: OwnerForSeller[], existingNames: string[], access: SellerAccess): SellerParty[] {
  if (!access.name) return [];
  const seen = new Set(existingNames.map(foldNameVariants));
  const out: SellerParty[] = [];
  for (const o of owners) {
    const name = fit(o.name, MAX_NAME);
    if (!name) continue;
    const key = foldNameVariants(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      role: "seller",
      partyType: o.corporateNumber || o.companyRegistryNumber || CORPORATE_NAME.test(name) ? "corporation" : "individual",
      name,
      address: access.address ? fit(o.currentAddress?.trim() ? o.currentAddress : o.address, MAX_ADDRESS) : null,
      phone: access.phone ? fit(o.phone, MAX_PHONE) : null,
      isSelf: false,
    });
  }
  return out;
}

/** 今の所有者を売主に足し、足した人数を返す。⚠取引の行をロックする=同時に押されても同じ人を2回足さない。 */
export async function addSellersFromOwners(
  tx: Prisma.TransactionClient,
  o: { dealId: string; propertyId: string; access: SellerAccess },
): Promise<number> {
  if (!o.access.name) return 0;
  await tx.$queryRaw`SELECT "id" FROM "deals" WHERE "id" = ${o.dealId}::uuid FOR UPDATE`;
  const links = await tx.propertyOwner.findMany({
    where: { propertyId: o.propertyId, endDate: null, owner: { isArchived: false } },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    select: { owner: { select: SELLER_OWNER_SELECT } },
  });
  const existing = await tx.dealParty.findMany({ where: { dealId: o.dealId, role: "seller" }, select: { name: true, isSelf: true } });
  // 自社が売主の取引には、物件の所有者を足さない。
  if (existing.some((p) => p.isSelf)) return 0;
  const company = resolveCompanyProfile(await tx.companyProfile.findUnique({ where: { id: "singleton" } }));
  const owners = ownersExceptCompany(links.map((l) => l.owner), company.nameJa);
  const parties = sellerPartiesFromOwners(owners, existing.map((p) => p.name), o.access);
  if (parties.length > 0) {
    await tx.dealParty.createMany({
      data: parties.map((p, i) => ({ ...p, dealId: o.dealId, sortOrder: existing.length + i })),
    });
  }
  return parties.length;
}
