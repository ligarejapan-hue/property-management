import prisma from "@/lib/prisma";
import type { DealView } from "./view";

/** 取引の営業担当・業務担当の名前(書類確認書の頭に出す)。担当が無ければ DB を読まない。 */
export async function loadDealStaffNames(deal: Pick<DealView, "salesStaffId" | "opsStaffId">): Promise<{ sales: string | null; ops: string | null }> {
  const ids = [...new Set([deal.salesStaffId, deal.opsStaffId].filter((x): x is string => !!x))];
  if (!ids.length) return { sales: null, ops: null };
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  const nameOf = (id: string | null) => (id ? users.find((u) => u.id === id)?.name ?? null : null);
  return { sales: nameOf(deal.salesStaffId), ops: nameOf(deal.opsStaffId) };
}
