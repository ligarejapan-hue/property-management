import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { requireDeal } from "@/lib/deals/guard";
import { dealCreateSchema, EMPTY_SNAPSHOT } from "@/lib/deals/schemas";
import { DEAL_BUSINESS_TYPES, DEAL_STATUSES } from "@/lib/deals/constants";
import { jstYear, nextDealNo } from "@/lib/deals/deal-no";
import { jstDateString } from "@/lib/deals/datetime";
import { buildSnapshotFromProperty, SNAPSHOT_PROPERTY_SELECT } from "@/lib/deals/snapshot";
import { propertyKindFromPropertyType } from "@/lib/deals/property-kind";
import { loadDealSettings } from "@/lib/deals/settings-store";
import { isKnownPropertyKind } from "@/lib/deals/settings";
import { consumptionTaxRateBp } from "@/lib/deals/rate-tables";
import { normalizeTradeSide } from "@/lib/deals/change-values";
import { DEAL_LIST_SELECT, toDealListItem } from "@/lib/deals/view";

const NO_STORE = { "Cache-Control": "no-store" };
const PAGE_SIZE = 50;
/** 取引番号がぶつかったとき(同時に作った)に作り直す回数。 */
const DEAL_NO_ATTEMPTS = 3;

const listQuery = z.object({
  status: z.enum(DEAL_STATUSES).optional(),
  businessType: z.enum(DEAL_BUSINESS_TYPES).optional(),
  assignee: z.union([z.literal("me"), z.string().uuid()]).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
});

/** 取引の一覧(新しい順・50件ずつ)。 */
export async function GET(request: Request) {
  try {
    const { session } = await requireDeal("read");
    const sp = new URL(request.url).searchParams;
    const query = listQuery.parse(Object.fromEntries([...sp.entries()].filter(([, v]) => v.trim() !== "")));
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.businessType ? { businessType: query.businessType } : {}),
      ...(query.assignee ? { assigneeId: query.assignee === "me" ? session.id : query.assignee } : {}),
      ...(query.q
        ? { OR: [{ name: { contains: query.q, mode: "insensitive" as const } }, { dealNo: { contains: query.q } }] }
        : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.deal.findMany({
        where, select: DEAL_LIST_SELECT, orderBy: [{ createdAt: "desc" }],
        skip: (query.page - 1) * PAGE_SIZE, take: PAGE_SIZE,
      }),
      prisma.deal.count({ where }),
    ]);
    return NextResponse.json(
      { deals: rows.map(toDealListItem), total, page: query.page, pageSize: PAGE_SIZE },
      { headers: NO_STORE },
    );
  } catch (error) {
    return handleApiError(error);
  }
}

const isUniqueViolation = (e: unknown) => (e as { code?: string } | null)?.code === "P2002";

/**
 * 取引を作る。物件から作るときは、写しと種別をサーバーで物件から入れる(送られた写しは使わない)。
 * 物件は「物件を見る権限」+「現地担当は自分の作成・担当の物件だけ」(物件の詳しい画面と同じ範囲)。
 */
export async function POST(request: Request) {
  try {
    const { session, perms } = await requireDeal("write");
    const body = dealCreateSchema.parse(await parseJsonBody(request));

    let snapshot = body.propertySnapshot ?? EMPTY_SNAPSHOT;
    let propertyKind = body.propertyKind ?? null;
    if (body.propertyId) {
      if (!hasPermission(perms, "property", "read")) {
        throw new ApiError(403, "物件を見る権限がありません", "FORBIDDEN");
      }
      const p = await prisma.property.findUnique({ where: { id: body.propertyId }, select: SNAPSHOT_PROPERTY_SELECT });
      // 見られない物件は「無い」と同じ返事にする(あることも住所も漏らさない)。
      if (!p || !canAccessPropertyRecord(session, p)) {
        throw new ApiError(404, "物件が見つかりません", "PROPERTY_NOT_FOUND");
      }
      snapshot = buildSnapshotFromProperty(p);
      propertyKind = propertyKind ?? propertyKindFromPropertyType(p.propertyType);
    }

    const settings = await loadDealSettings();
    if (!isKnownPropertyKind(settings, propertyKind)) {
      throw new ApiError(422, "物件種別を選び直してください", "UNKNOWN_PROPERTY_KIND");
    }

    const now = new Date();
    const rateRows = await prisma.dealRateTable.findMany({ where: { kind: "consumption_tax" } });
    const taxRateBp = consumptionTaxRateBp(rateRows, jstDateString(now));
    const year = jstYear(now);

    for (let attempt = 1; ; attempt++) {
      const latest = await prisma.deal.findFirst({
        where: { dealNo: { startsWith: `${year}-` } }, orderBy: { dealNo: "desc" }, select: { dealNo: true },
      });
      const dealNo = nextDealNo(year, latest?.dealNo ?? null);
      try {
        const created = await prisma.deal.create({
          data: {
            dealNo, name: body.name, businessType: body.businessType,
            tradeSide: normalizeTradeSide(body.businessType, body.tradeSide),
            propertyId: body.propertyId ?? null, propertyKind, hasOc: body.hasOc ?? false,
            propertySnapshot: snapshot, taxRateBp, createdById: session.id,
          },
          select: { id: true, dealNo: true },
        });
        await writeAuditLog({
          userId: session.id, action: "deal_create", targetTable: "deals", targetId: created.id,
          detail: { fields: Object.keys(body).sort() },
        });
        return NextResponse.json(created, { status: 201, headers: NO_STORE });
      } catch (e) {
        if (isUniqueViolation(e) && attempt < DEAL_NO_ATTEMPTS) continue;
        if (isUniqueViolation(e)) throw new ApiError(409, "ほかの人が同時に作成しました。もう一度「作成」を押してください。", "DEAL_NO_BUSY");
        throw e;
      }
    }
  } catch (error) {
    return handleApiError(error);
  }
}
