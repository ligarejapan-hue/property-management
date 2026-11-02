import type { Prisma } from "@/generated/prisma";
import type { PermissionEntry } from "@/lib/api-helpers";
import { hasPermission, isMaskFreeLevel, resolveOwnerDisplayConfig } from "@/lib/permissions";
import { partyInputSchema } from "./schemas";

/**
 * 物件の所有者を取引の売主に入れる。
 * ⚠氏名・住所・電話は、所有者情報の表示レベルでそのまま見られる人の操作のときだけ入れる(伏せた値を保存しない)。
 * ⚠作った値は DB に入れるだけ。監査・console には出さない。
 */
export interface SellerAccess { name: boolean; address: boolean; phone: boolean }

export function sellerAccessOf(perms: PermissionEntry[]): SellerAccess {
  const canReadOwner = hasPermission(perms, "owner", "read");
  const levels = resolveOwnerDisplayConfig(perms);
  return {
    name: canReadOwner && isMaskFreeLevel(levels.name),
    address: canReadOwner && isMaskFreeLevel(levels.address),
    phone: canReadOwner && isMaskFreeLevel(levels.phone),
  };
}

export const SELLER_OWNER_SELECT = {
  isPrimary: true,
  owner: { select: { name: true, address: true, currentAddress: true, phone: true, corporateNumber: true, companyRegistryNumber: true } },
} as const;

export interface SellerSourceLink {
  isPrimary: boolean;
  owner: {
    name: string; address: string | null; currentAddress: string | null; phone: string | null;
    corporateNumber: string | null; companyRegistryNumber: string | null;
  };
}

const CORPORATE_NAME = /株式会社|有限会社|合同会社|合資会社|合名会社|社団法人|財団法人|医療法人|社会福祉法人|学校法人|宗教法人|NPO法人|[（(][株有][）)]/;
const sameName = (a: string, b: string) => a.replace(/\s/g, "") === b.replace(/\s/g, "");
const filled = (v: string | null) => (v && v.trim() ? v.trim() : null);

/** 欄の決まりに収まる値だけ。⚠途中で切らない(切った住所を正しい値に見せない)。 */
function fitting(role: { name: string; address: string | null; phone: string | null; partyType: "individual" | "corporation" }) {
  const base = { role: "seller" as const, partyType: role.partyType, name: role.name, isSelf: false };
  if (!partyInputSchema.safeParse(base).success) return null;
  const ok = (extra: object) => partyInputSchema.safeParse({ ...base, ...extra }).success;
  return {
    ...base,
    address: role.address !== null && ok({ address: role.address }) ? role.address : null,
    phone: role.phone !== null && ok({ phone: role.phone }) ? role.phone : null,
  };
}

/** 売主の行を作る。主な所有者が先。持分は物件に数字がないので空。自社の名前の所有者は入れない。 */
export function sellerRowsFromOwners(links: SellerSourceLink[], access: SellerAccess, companyName: string) {
  if (!access.name) return [];
  const ordered = [...links.filter((l) => l.isPrimary), ...links.filter((l) => !l.isPrimary)];
  return ordered
    .filter((l) => !sameName(l.owner.name, companyName))
    .flatMap(({ owner }) => {
      const row = fitting({
        name: owner.name.trim(),
        partyType: owner.corporateNumber || owner.companyRegistryNumber || CORPORATE_NAME.test(owner.name) ? "corporation" : "individual",
        address: access.address ? filled(owner.currentAddress) ?? filled(owner.address) : null,
        phone: access.phone ? filled(owner.phone) : null,
      });
      return row ? [row] : [];
    })
    .map((row, sortOrder) => ({ ...row, sortOrder }));
}

export type FillSellersResult = { status: "filled" | "sellers_exist" | "no_owners" | "forbidden"; count: number };

/** 売主が1人もいないときだけ足す(自社を売主にした取引も、手で入れた売主も上書きしない)。呼び元は取引の行を握って呼ぶ。 */
export async function fillSellersFromOwners(
  tx: Prisma.TransactionClient,
  input: { dealId: string; propertyId: string; access: SellerAccess; companyName: string },
): Promise<FillSellersResult> {
  if (!input.access.name) return { status: "forbidden", count: 0 };
  if ((await tx.dealParty.count({ where: { dealId: input.dealId, role: "seller" } })) > 0) return { status: "sellers_exist", count: 0 };
  const links = await tx.propertyOwner.findMany({
    where: { propertyId: input.propertyId, owner: { isArchived: false } },
    select: SELLER_OWNER_SELECT,
    orderBy: { createdAt: "asc" },
  });
  const rows = sellerRowsFromOwners(links, input.access, input.companyName);
  if (rows.length === 0) return { status: "no_owners", count: 0 };
  await tx.dealParty.createMany({ data: rows.map((r) => ({ ...r, dealId: input.dealId })) });
  return { status: "filled", count: rows.length };
}
