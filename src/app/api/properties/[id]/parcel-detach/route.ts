import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { Prisma, type PropertyType } from "@/generated/prisma";
import { ApiError, getApiSession, getUserPermissions, handleApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { hasPermission } from "@/lib/permissions";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { assertNotEditLockedByOther } from "@/lib/edit-lock/service";
import { readScreenTokenHash, readLockId } from "@/lib/edit-lock/screen-token";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { supportsUnitFields } from "@/lib/property-building-name";
import { extraParcelsText } from "@/lib/property-parcels";
import { detachCommentForNew, detachCommentForOriginal, planParcelDetach } from "@/lib/property-parcel-detach";
import { readTargetParcels } from "@/lib/deals/target-parcels";

type Ctx = { params: Promise<{ id: string }> };
const bodySchema = z.object({ version: z.number().int().positive(), rowId: z.string().min(1).max(64) }).strict();
const CONFLICT = "他のユーザーが先に更新しています。画面を再読み込みしてください。";

/**
 * 「この筆を別の物件にする」(2026-11-06 発注者 案A 3回目の3つ目)。
 * 足した行を1つ新しい物件の1筆目・1棟目にして元の物件から外し、両方の物件のコメントに相手へのリンクを残す。
 * 写すのは基本と所有者のつながりだけ(発注者決定)。所有者のつながりは所有者を書ける人のときだけ写す
 * (所有者の紐付けの画面と同じ権限)。
 * ⚠その行を「この取引の土地・建物」で選んでいる取引があれば止める(発注者決定=取引の書類・照合を黙って変えない)。
 * ⚠物件の保存と同じ守り: 物件の編集権限・物件の行ロック→編集中の鍵→担当範囲(ロック後)→版の番号。
 * ⚠監査には地番・所在を出さない。
 */
export async function POST(request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    z.string().uuid().parse(id);
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    if (!hasPermission(perms, "property", "write")) throw new ApiError(403, "物件編集の権限がありません", "FORBIDDEN");
    const canLinkOwners = hasPermission(perms, "owner", "write");
    const { version, rowId } = bodySchema.parse(await request.json());
    const lockId = readLockId(request);

    const done = await prisma.$transaction(async (tx) => {
      await lockPropertyRow(tx, id);
      await assertNotEditLockedByOther(tx, {
        resourceType: "property", resourceId: id, userId: session.id, screenTokenHash: readScreenTokenHash(request), lockId,
      });
      const cur = await tx.property.findUnique({
        where: { id },
        select: {
          version: true, createdBy: true, assignedTo: true, propertyType: true, address: true, postalCode: true,
          extraParcels: true, businessType: true, registryStatus: true,
        },
      });
      if (!cur || !canAccessPropertyRecord(session, cur)) throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
      if (cur.version !== version) throw new ApiError(409, CONFLICT, "VERSION_CONFLICT");
      if (supportsUnitFields(cur.propertyType)) throw new ApiError(422, "区分マンションでは使えません", "UNIT_PROPERTY");
      const plan = planParcelDetach(cur, rowId);
      if (!plan.ok) throw new ApiError(422, plan.message, "PARCEL_NOT_FOUND");
      // 謄本の自動取得中は取得の対象(行)を動かさない(取れた謄本が行の無い物件に入る・物件の保存と同じ考え)。
      if (cur.registryStatus === "scheduled") {
        throw new ApiError(409, "謄本の自動取得の処理中です。完了後にお試しください", "REGISTRY_FETCH_IN_PROGRESS");
      }

      // その行を選んでいる取引があれば止める(取引の行を id 順にロックしてから読む=選びの保存と交差させない)。
      await tx.$queryRaw`SELECT "id" FROM "deals" WHERE "property_id" = ${id}::uuid ORDER BY "id" FOR UPDATE`;
      const deals = await tx.deal.findMany({ where: { propertyId: id }, select: { targetParcels: true } });
      if (deals.some((d) => readTargetParcels(d.targetParcels)?.includes(rowId))) {
        throw new ApiError(409, "この土地・建物を「この取引の土地・建物」で選んでいる取引があります。先に取引の選びから外してください", "PARCEL_IN_DEAL");
      }

      const res = await tx.property.updateMany({
        where: { id, version, registryStatus: { not: "scheduled" } },
        data: { extraParcels: plan.remaining as unknown as Prisma.InputJsonValue, version: { increment: 1 } },
      });
      if (res.count === 0) throw new ApiError(409, CONFLICT, "VERSION_CONFLICT");

      const created = await tx.property.create({
        data: {
          propertyType: plan.fields.propertyType as PropertyType,
          address: plan.fields.address,
          postalCode: plan.fields.postalCode,
          lotNumber: plan.fields.lotNumber,
          buildingNumber: plan.fields.buildingNumber,
          realEstateNumber: plan.fields.realEstateNumber,
          landArea: plan.fields.landArea,
          totalFloorArea: plan.fields.totalFloorArea,
          businessType: cur.businessType,
          assignedTo: cur.assignedTo,
          registryStatus: "unconfirmed",
          dmStatus: "hold",
          createdBy: session.id,
        },
        select: { id: true },
      });

      let ownersCopied = 0;
      if (canLinkOwners) {
        const links = await tx.propertyOwner.findMany({
          where: { propertyId: id }, select: { ownerId: true, relationship: true, isPrimary: true, startDate: true, endDate: true },
        });
        if (links.length) {
          await tx.propertyOwner.createMany({ data: links.map((l) => ({ ...l, propertyId: created.id })) });
          ownersCopied = links.length;
        }
      }

      await tx.changeLog.create({
        data: {
          targetTable: "properties", targetId: id, fieldName: "extraParcels", source: "manual", changedBy: session.id,
          oldValue: extraParcelsText(cur.extraParcels), newValue: extraParcelsText(plan.remaining),
        },
      });
      await tx.comment.create({ data: { propertyId: id, authorId: session.id, body: detachCommentForOriginal(plan.row, created.id), parentId: null } });
      await tx.comment.create({ data: { propertyId: created.id, authorId: session.id, body: detachCommentForNew(plan.row, id), parentId: null } });
      // 全部(null)を扱っている取引からは、この行が外れる(知らせる)。
      const dealsCoveringAll = deals.filter((d) => !readTargetParcels(d.targetParcels)).length;
      return { newPropertyId: created.id, ownersCopied, kind: plan.row.kind, dealsCoveringAll };
    });

    await writeAuditLog({
      userId: session.id, action: "create", targetTable: "properties", targetId: done.newPropertyId,
      detail: { from: "parcel_detach", sourcePropertyId: id },
    });
    await writeAuditLog({
      userId: session.id, action: "property_parcel_detach", targetTable: "properties", targetId: id,
      detail: { newPropertyId: done.newPropertyId, kind: done.kind, ownersCopied: done.ownersCopied },
    });
    return NextResponse.json(
      { version: version + 1, newPropertyId: done.newPropertyId, ownersCopied: done.ownersCopied, ownersSkipped: !canLinkOwners, dealsCoveringAll: done.dealsCoveringAll },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
