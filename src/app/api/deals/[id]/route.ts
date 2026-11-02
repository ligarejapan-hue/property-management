import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { hasExplicitWritePerm, hasPermission } from "@/lib/permissions";
import { sellerAccessOf } from "@/lib/deals/seller-from-owners";
import { writeAuditLog } from "@/lib/audit";
import { recordChangesInTx } from "@/lib/change-log";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { assertActiveUser } from "@/lib/agent-inquiry/user-check";
import { requireDeal, DEAL_VERSION_CONFLICT_MESSAGE } from "@/lib/deals/guard";
import { dealUpdateSchema } from "@/lib/deals/schemas";
import { loadDealSettings } from "@/lib/deals/settings-store";
import { isKnownPropertyKind } from "@/lib/deals/settings";
import { DEAL_TRACKED_FIELDS, dealChangeValues, toDealUpdateData } from "@/lib/deals/change-values";
import { DEAL_DETAIL_SELECT, toDealView } from "@/lib/deals/view";
import { syncDealScheduleSafe, taxesEnteredOf } from "@/lib/deals/schedule-sync";
import type { ScheduleEvent } from "@/lib/deals/schedule";
import { canChangeDealAssignee, canChangeDealStatus, caseStatusWouldMove, syncCaseStatusFromDeals, syncDealDocRetention } from "@/lib/deals/status-link";
import { lockPropertyRow } from "@/lib/property-record-guard";

type Ctx = { params: Promise<{ id: string }> };
const NO_STORE = { "Cache-Control": "no-store" };
const jsonObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const idOf = async (ctx: Ctx) => z.string().uuid().parse((await ctx.params).id);

/** 取引の詳しい中身。物件を開くリンクは、その物件を見られる人にだけ出す。 */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { session, perms } = await requireDeal("read");
    const id = await idOf(ctx);
    const row = await prisma.deal.findUnique({ where: { id }, select: { ...DEAL_DETAIL_SELECT, createdById: true } });
    if (!row) throw new ApiError(404, "取引が見つかりません", "NOT_FOUND");
    const p = row.propertyId
      ? await prisma.property.findUnique({ where: { id: row.propertyId }, select: { createdBy: true, assignedTo: true } })
      : null;
    const canOpenProperty = !!p && hasPermission(perms, "property", "read") && canAccessPropertyRecord(session, p);
    const canChangeStatus = canChangeDealStatus(session, row, p);
    const canChangeAssignee = canChangeDealAssignee(session, row, p);
    const canMoveCaseStatus = !!p && hasPermission(perms, "property", "write") && canAccessPropertyRecord(session, p);
    // 物件の所有者を売主に入れるボタン(所有者の氏名をそのまま見られる人だけ)。
    const canFillSellers = canOpenProperty && hasPermission(perms, "deal", "write") && sellerAccessOf(perms).name;
    // 横の欄の物件の編集で、問い合わせ者の欄を出すか(物件の画面と同じ条件)。
    const canEditInquirer = hasPermission(perms, "owner", "read") && hasExplicitWritePerm(perms, "owner_name");
    return NextResponse.json({ deal: toDealView(row), canOpenProperty, canChangeStatus, canChangeAssignee, canMoveCaseStatus, canFillSellers, canEditInquirer }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}

/** 基本・物件の写し・相手方の仲介会社の変更(版の番号で 409・送っていない項目は触らない)。 */
export async function PATCH(request: Request, ctx: Ctx) {
  try {
    const { session, perms } = await requireDeal("write");
    const id = await idOf(ctx);
    const { version, ...patch } = dealUpdateSchema.parse(await parseJsonBody(request));
    for (const key of ["assigneeId", "licensedAgentId", "salesStaffId", "opsStaffId"] as const) {
      await assertActiveUser(patch[key], "INVALID_STAFF");
    }
    if (patch.propertyKind !== undefined && !isKnownPropertyKind(await loadDealSettings(), patch.propertyKind)) {
      throw new ApiError(422, "物件種別を選び直してください", "UNKNOWN_PROPERTY_KIND");
    }

    let event: ScheduleEvent = {};
    let caseStatusNotChanged = false;
    await prisma.$transaction(async (tx) => {
      const cur = await tx.deal.findUnique({ where: { id }, select: { ...DEAL_DETAIL_SELECT, createdById: true } });
      if (!cur) throw new ApiError(404, "取引が見つかりません", "NOT_FOUND");
      // 権限の判定に使う行と、書き込む行を同じ版にそろえる(下の updateMany も同じ版を条件にする)。
      if (cur.version !== version) throw new ApiError(409, DEAL_VERSION_CONFLICT_MESSAGE, "VERSION_CONFLICT");
      // 案件ステータスと連動する(lib/deals/status-link.ts)。ロックは物件の行 → 取引の行(下の updateMany)の順。
      const statusChanges = patch.status !== undefined && patch.status !== cur.status;
      const linkedPropertyId = statusChanges ? cur.propertyId : null;
      if (linkedPropertyId) await lockPropertyRow(tx, linkedPropertyId);
      const assigneeChanges = patch.assigneeId !== undefined && patch.assigneeId !== cur.assigneeId;
      let canMoveCase = false;
      if (statusChanges || assigneeChanges) {
        const property = cur.propertyId
          ? await tx.property.findUnique({ where: { id: cur.propertyId }, select: { createdBy: true, assignedTo: true } })
          : null;
        // ⚠案件ステータスを動かすのは、その物件を編集できる人だけ。ロック後に担当範囲を見る(作成時と同じ)。
        canMoveCase = !!property && hasPermission(perms, "property", "write") && canAccessPropertyRecord(session, property);
        if (statusChanges && !canChangeDealStatus(session, cur, property)) {
          throw new ApiError(403, "取引の状態を変えられるのは、管理者と担当者だけです", "DEAL_STATUS_FORBIDDEN");
        }
        if (assigneeChanges && !canChangeDealAssignee(session, cur, property)) {
          throw new ApiError(403, "取引の担当者を変えられるのは、管理者と担当者だけです", "DEAL_ASSIGNEE_FORBIDDEN");
        }
      }
      const data = toDealUpdateData(patch, cur.businessType);
      // 資金計画表・事業計画書は plan_inputs のそれぞれの鍵(funding / business)だけを差し替える(ほかの鍵は残す)。
      if (patch.businessPlan !== undefined && (patch.businessType ?? cur.businessType) !== "resale") {
        throw new ApiError(422, "事業計画書は買取再販の取引だけで使えます", "NOT_RESALE");
      }
      if (patch.fundingPlan !== undefined || patch.businessPlan !== undefined) {
        data.planInputs = {
          ...jsonObject(cur.planInputs),
          ...(patch.fundingPlan !== undefined ? { funding: patch.fundingPlan } : {}),
          ...(patch.businessPlan !== undefined ? { business: patch.businessPlan } : {}),
        };
      }
      const res = await tx.deal.updateMany({ where: { id, version }, data: { ...data, version: { increment: 1 } } });
      if (res.count === 0) throw new ApiError(409, DEAL_VERSION_CONFLICT_MESSAGE, "VERSION_CONFLICT");
      if (statusChanges && patch.status) await syncDealDocRetention(tx, id, cur.status, patch.status);
      // 段取りの自動の完了は「変わったとき」だけ(完了を取り消した項目を、ほかの保存で戻さない)。
      event = {
        settled: patch.status === "settled" && cur.status !== "settled",
        taxesEntered: patch.settlementTerms !== undefined && taxesEnteredOf(patch.settlementTerms) && !taxesEnteredOf(cur.settlementTerms),
      };
      await recordChangesInTx(tx, {
        targetTable: "deals", targetId: id, changedBy: session.id,
        oldValues: dealChangeValues(cur), newValues: dealChangeValues({ ...cur, ...data }),
        trackedFields: DEAL_TRACKED_FIELDS, source: "manual",
      });
      if (linkedPropertyId) {
        if (canMoveCase) await syncCaseStatusFromDeals(tx, { propertyId: linkedPropertyId, changedBy: session.id });
        else caseStatusNotChanged = await caseStatusWouldMove(tx, linkedPropertyId);
      }
    });

    // 日付・条件・担当の変更を段取りに反映する(失敗しても保存は止めない)。
    await syncDealScheduleSafe(id, { userId: session.id, event });

    await writeAuditLog({
      userId: session.id, action: "deal_update", targetTable: "deals", targetId: id,
      detail: { fields: Object.keys(patch).sort() },
    });
    return NextResponse.json({ version: version + 1, ...(caseStatusNotChanged ? { caseStatusNotChanged: true } : {}) }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}
