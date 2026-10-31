import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { writeAuditLog } from "@/lib/audit";
import { requireDeal } from "@/lib/deals/guard";
import { DEAL_DETAIL_SELECT, toDealView } from "@/lib/deals/view";
import { loadDealSettings } from "@/lib/deals/settings-store";
import { kindBaseOf } from "@/lib/deals/constants";
import { jstDateString } from "@/lib/deals/datetime";
import { buildCrosscheck, type RegistryFacts } from "@/lib/deals/crosscheck";
import { latestIssuedDocs, readIssuedFacts } from "@/lib/deals/crosscheck-facts";
import { loadCrosscheckRegistry } from "@/lib/deals/crosscheck-load";
import { registryPropertyFor } from "@/lib/deals/registry-doc-info";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 取引の数値照合。確認用で、取引のデータには書き込まない。発行は止めない(画面が確認を挟むだけ)。
 * - 物件の値は物件を見られる人だけ、謄本の値は謄本も見られる人だけ。
 * - 売主名を比べるのは、謄本・物件・所有者の閲覧がすべてある人だけ。売主名を書き換えて結果を見れば
 *   登記名義人を当てられてしまうため、権限が無い人には比べた結果も返さない。謄本の所有者名は誰にも返さない。
 * - 謄本を読んだときは監査に件数だけを残す。
 */
export async function GET(_request: Request, ctx: Ctx) {
  try {
    const { session, perms } = await requireDeal("read");
    const id = z.string().uuid().parse((await ctx.params).id);
    const row = await prisma.deal.findUnique({ where: { id }, select: DEAL_DETAIL_SELECT });
    if (!row) throw new ApiError(404, "取引が見つかりません", "NOT_FOUND");
    const deal = toDealView(row);
    const settings = await loadDealSettings();
    const kindBase = kindBaseOf(settings, deal.propertyKind);

    let property = null;
    if (deal.propertyId && hasPermission(perms, "property", "read")) {
      const p = await prisma.property.findUnique({
        where: { id: deal.propertyId },
        select: {
          createdBy: true, assignedTo: true, exclusiveArea: true, exclusiveAreaRegistry: true,
          landArea: true, landAreaMethod: true, totalFloorArea: true,
        },
      });
      if (p && canAccessPropertyRecord(session, p)) property = p;
    }

    const registryProperty = await registryPropertyFor(session, perms, deal.propertyId);
    const canCompareNames = !!registryProperty && hasPermission(perms, "owner", "read");
    let registry: RegistryFacts = { status: deal.propertyId ? "denied" : "none" };
    if (registryProperty) {
      try {
        registry = await loadCrosscheckRegistry(registryProperty, { kindBase, includeOwners: canCompareNames });
      } catch {
        // 中身に氏名が入りうるので例外は出さない。読めないだけで画面は止めない。
        registry = { status: "unreadable" };
      }
    }

    const docs = await prisma.dealDocument.findMany({
      where: { dealId: id }, orderBy: [{ issuedAt: "desc" }, { version: "desc" }],
      select: { id: true, docType: true, variant: true, version: true, issuedAt: true, inputSnapshot: true, calcSnapshot: true },
    });

    const crosscheck = buildCrosscheck({
      kindBase, price: deal.price,
      settlementDate: deal.settlementAt ? jstDateString(new Date(deal.settlementAt)) : null,
      snapshot: { floorArea: deal.propertySnapshot.floorArea, landArea: deal.propertySnapshot.landArea },
      property: property && {
        exclusiveArea: property.exclusiveArea, exclusiveAreaRegistry: property.exclusiveAreaRegistry,
        landArea: property.landArea, landAreaMethod: property.landAreaMethod, totalFloorArea: property.totalFloorArea,
      },
      registry,
      // 物件の無い取引には比べる謄本が無い(権限の話ではない)。
      sellerCompare: !deal.propertyId || canCompareNames ? "allowed" : "denied",
      sellers: deal.parties.filter((p) => p.role === "seller").map((p) => ({ name: p.name, shareNum: p.shareNum, shareDen: p.shareDen })),
      documents: latestIssuedDocs(docs).map(readIssuedFacts),
    });

    if (registryProperty && registry.status !== "none") {
      await writeAuditLog({
        userId: session.id, action: "deal_crosscheck_view", targetTable: "deals", targetId: id,
        detail: { summary: crosscheck.summary, mismatches: crosscheck.mismatchCount, compared: crosscheck.comparedCount },
      });
    }
    return NextResponse.json({ crosscheck }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
