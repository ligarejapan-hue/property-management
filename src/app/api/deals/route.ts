import { containsVariants, searchVariants } from "@/lib/notation";
import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { requireDeal } from "@/lib/deals/guard";
import { DEFAULT_TERMS, dealCreateSchema, EMPTY_SNAPSHOT, type SettlementTerms } from "@/lib/deals/schemas";
import { DEAL_BUSINESS_TYPES, DEAL_STATUSES, type DealStatus } from "@/lib/deals/constants";
import { initialDealStatusForCase, syncCaseStatusFromDeals } from "@/lib/deals/status-link";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { jstYear, nextDealNo } from "@/lib/deals/deal-no";
import { jstDateString } from "@/lib/deals/datetime";
import { buildSnapshotFromProperty, settlementFeesFromProperty, SNAPSHOT_PROPERTY_SELECT } from "@/lib/deals/snapshot";
import { addSellersFromOwners, sellerAccessOf } from "@/lib/deals/seller-from-owners";
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
        ? {
            OR: [
              ...containsVariants("name", query.q, "insensitive"),
              { dealNo: { contains: query.q } },
              ...searchVariants(query.q).map((v) => ({ propertySnapshot: { path: ["buildingName"], string_contains: v, mode: "insensitive" as const } })),
              ...searchVariants(query.q).map((v) => ({ propertySnapshot: { path: ["address"], string_contains: v, mode: "insensitive" as const } })),
            ],
          }
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
    let settlementTerms: SettlementTerms | undefined;
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
      const fees = settlementFeesFromProperty(p);
      if (Object.keys(fees).length > 0) settlementTerms = { ...DEFAULT_TERMS, ...fees };
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
        const propertyId = body.propertyId ?? null;
        const created = await prisma.$transaction(async (tx) => {
          // 案件ステータスと連動する(lib/deals/status-link.ts)。ロックは物件の行が先。
          // ⚠案件ステータスを動かすのは、その物件を編集できる人が作ったときだけ。ロック後に担当範囲を見直す。
          let status: DealStatus = "considering";
          let canMoveCase = false;
          if (propertyId) {
            await lockPropertyRow(tx, propertyId);
            const current = await tx.property.findUnique({
              where: { id: propertyId }, select: { caseStatus: true, createdBy: true, assignedTo: true },
            });
            if (current) {
              status = initialDealStatusForCase(current.caseStatus);
              canMoveCase = hasPermission(perms, "property", "write") && canAccessPropertyRecord(session, current);
            }
          }
          const row = await tx.deal.create({
            data: {
              // 取引名の入力は廃止。列は残し、物件が未入力のときの見出しに取引番号を入れておく。
              dealNo, name: dealNo, businessType: body.businessType, status,
              tradeSide: normalizeTradeSide(body.businessType, body.tradeSide),
              propertyId, propertyKind, hasOc: body.hasOc ?? false,
              propertySnapshot: snapshot, taxRateBp, createdById: session.id,
              ...(settlementTerms ? { settlementTerms } : {}),
            },
            select: { id: true, dealNo: true },
          });
          // 売主は物件の今の所有者。違う場合は当事者タブで手で直す。
          if (propertyId) await addSellersFromOwners(tx, { dealId: row.id, propertyId, access: sellerAccessOf(perms) });
          if (propertyId && canMoveCase) await syncCaseStatusFromDeals(tx, { propertyId, changedBy: session.id });
          return row;
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
