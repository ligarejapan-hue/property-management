import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, getApiSession, getOwnerDisplayConfig, getUserPermissions, handleApiError } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { isPlainOwnerLevel } from "@/lib/dm-export";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { writeAuditLog } from "@/lib/audit";
import { stopFollowupManually } from "@/lib/lead-followup/manual-stop";
import { FOLLOWUP_VIEW_SELECT, toFollowupView } from "@/lib/lead-followup/view";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 物件の「追客メール」の様子(GET)と「追客を止める」(POST)。設計 2026-11-16 §6 PR2。
 * - 見られる人: 物件を読める(property:read+担当範囲)うえで、所有者のメールを平文で見られる人だけ。
 *   それ以外には visible=false だけを返す(送った記録から「メールがある」と分かるため。受付メールと同じ扱い)。
 * - 止められる人: 物件を書ける(property:write+担当範囲)うえで、所有者のメールを平文で見られる人。
 * - 応答・監査にアドレス・件名・本文は入れない。
 */

async function loadAccess(id: string, action: "read" | "write") {
  const session = await getApiSession();
  const perms = await getUserPermissions(session.id);
  if (!hasPermission(perms, "property", action)) {
    throw new ApiError(403, action === "read" ? "権限がありません" : "物件を更新する権限(write)がありません", "FORBIDDEN");
  }
  const property = await prisma.property.findUnique({
    where: { id },
    select: { id: true, createdBy: true, assignedTo: true },
  });
  if (!property) throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
  if (!canAccessPropertyRecord(session, property)) throw new ApiError(403, "この物件を扱う権限がありません", "FORBIDDEN");
  const cfg = await getOwnerDisplayConfig(session.id, perms);
  return { session, emailVisible: isPlainOwnerLevel(cfg.email) };
}

async function loadView(propertyId: string) {
  const row = await prisma.leadFollowup.findUnique({ where: { propertyId }, select: FOLLOWUP_VIEW_SELECT });
  return toFollowupView(row);
}

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const id = z.string().uuid().parse((await ctx.params).id);
    const { emailVisible } = await loadAccess(id, "read");
    const body = emailVisible ? { visible: true, followup: await loadView(id) } : { visible: false, followup: null };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(_req: Request, ctx: Ctx) {
  try {
    const id = z.string().uuid().parse((await ctx.params).id);
    const { session, emailVisible } = await loadAccess(id, "write");
    if (!emailVisible) throw new ApiError(403, "所有者のメールを見る権限がありません", "FORBIDDEN");
    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      await lockPropertyRow(tx, id);
      // ロックのあとに読み直す: 先の読み取りとロックの間に物件が消えた・担当が替わったときは止める。
      const locked = await tx.property.findUnique({
        where: { id },
        select: { id: true, createdBy: true, assignedTo: true, introductionRoute: true, leadFollowup: { select: { id: true } } },
      });
      if (!locked) throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
      if (!canAccessPropertyRecord(session, locked)) throw new ApiError(403, "この物件を扱う権限がありません", "FORBIDDEN");
      // 追客の対象は一括査定の物件だけ。対象でない物件に止めた印を作ると、あとで一括査定に直しても
      // 追客が始まらなくなるので作らない(すでに追客の行があれば、導入ルートが変わっていても止められる)。
      if (locked.introductionRoute !== "bulk_assessment" && !locked.leadFollowup) {
        throw new ApiError(409, "一括査定の物件ではないため、追客メールの対象ではありません", "NOT_FOLLOWUP_TARGET");
      }
      return stopFollowupManually(tx, { kind: "property", propertyId: id }, session.id, now);
    });
    await writeAuditLog({
      userId: session.id,
      action: "lead_followup_manual_stop",
      targetTable: "properties",
      targetId: id,
      detail: { target: "property", result },
    });
    return NextResponse.json({ result, followup: await loadView(id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
