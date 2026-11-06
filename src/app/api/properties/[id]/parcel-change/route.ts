import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import { ApiError, getApiSession, getUserPermissions, handleApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { hasPermission } from "@/lib/permissions";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { assertNotEditLockedByOther } from "@/lib/edit-lock/service";
import { readScreenTokenHash, readLockId } from "@/lib/edit-lock/screen-token";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { supportsUnitFields } from "@/lib/property-building-name";
import { extraParcelsText } from "@/lib/property-parcels";
import { applyParcelChange, retargetDealParcels, SPLIT_PIECES_MAX } from "@/lib/property-parcel-changes";
import { readTargetParcels } from "@/lib/deals/target-parcels";
import { safeRandomId } from "@/lib/random-id";

type Ctx = { params: Promise<{ id: string }> };

const area = z.union([z.number(), z.string(), z.null()]).transform((v, ctx) => {
  if (v === null) return null;
  const s = String(v).normalize("NFKC").trim().replace(/,/g, "");
  if (s === "") return null;
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(s)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "面積は、0以上・小数2桁までの数で入力してください" });
    return z.NEVER;
  }
  return Number(s);
});
const number = z.string().max(100);
const bodySchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("split"), version: z.number().int().positive(), source: z.string().min(1).max(64),
    pieces: z.array(z.object({ number, area }).strict()).min(2).max(SPLIT_PIECES_MAX),
  }).strict(),
  z.object({
    op: z.literal("merge"), version: z.number().int().positive(), keys: z.array(z.string().min(1).max(64)).min(2).max(31),
    number, area,
  }).strict(),
]);

const CONFLICT = "他のユーザーが先に更新しています。画面を再読み込みしてください。";

/**
 * 分筆・合筆を記録する(2026-11-06 発注者 案A 3回目の2つ目・土地だけ)。
 * 物件の地番(1筆目)と「ほかの土地・建物」を書き換え、元の地番を物件のコメントに残し、
 * 分けた/合わせた筆を選んでいた取引の「この取引の土地・建物」を合わせる(発注者決定)。
 * ⚠物件の保存と同じ守り: 物件の編集権限・担当範囲(ロック後に読み直す)・編集中の鍵・版の番号・謄本の自動取得中の地番。
 * ⚠ロック順は物件の行 → 取引の行(取引の作成・状態の連動と同じ)。
 * ⚠監査には地番を出さない。
 */
export async function POST(request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    z.string().uuid().parse(id);
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    if (!hasPermission(perms, "property", "write")) throw new ApiError(403, "物件編集の権限がありません", "FORBIDDEN");
    const input = bodySchema.parse(await request.json());
    const lockId = readLockId(request);

    const done = await prisma.$transaction(async (tx) => {
      await lockPropertyRow(tx, id);
      await assertNotEditLockedByOther(tx, {
        resourceType: "property", resourceId: id, userId: session.id, screenTokenHash: readScreenTokenHash(request), lockId,
      });
      const cur = await tx.property.findUnique({
        where: { id },
        select: { version: true, createdBy: true, assignedTo: true, propertyType: true, lotNumber: true, extraParcels: true, registryStatus: true },
      });
      if (!cur || !canAccessPropertyRecord(session, cur)) throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
      if (cur.version !== input.version) throw new ApiError(409, CONFLICT, "VERSION_CONFLICT");
      if (supportsUnitFields(cur.propertyType)) throw new ApiError(422, "区分マンションでは分筆・合筆を記録できません", "UNIT_PROPERTY");

      const change = applyParcelChange(
        cur,
        input.op === "split" ? { op: "split", source: input.source, pieces: input.pieces } : { op: "merge", keys: input.keys, number: input.number, area: input.area },
        safeRandomId,
      );
      if (!change.ok) throw new ApiError(422, change.message, "INVALID_PARCEL_CHANGE");
      const lotChanged = (change.lotNumber ?? "") !== (cur.lotNumber ?? "");
      // 謄本の自動取得は地番で書類を選ぶ。取得中に地番を変えない(物件の保存と同じ)。
      if (lotChanged && cur.registryStatus === "scheduled") {
        throw new ApiError(409, "謄本の自動取得の処理中です。地番の変更は完了後にお試しください", "REGISTRY_FETCH_IN_PROGRESS");
      }

      const res = await tx.property.updateMany({
        where: { id, version: input.version, ...(lotChanged ? { registryStatus: { not: "scheduled" } } : {}) },
        data: {
          ...(lotChanged ? { lotNumber: change.lotNumber } : {}),
          extraParcels: change.extraParcels as unknown as Prisma.InputJsonValue,
          version: { increment: 1 },
        },
      });
      if (res.count === 0) throw new ApiError(409, CONFLICT, "VERSION_CONFLICT");

      // 変更履歴(物件の編集と同じ形)と、元の地番を残すコメント(記録した人の名前で)。
      const logs = [
        ...(lotChanged ? [{ fieldName: "lotNumber", oldValue: cur.lotNumber, newValue: change.lotNumber }] : []),
        { fieldName: "extraParcels", oldValue: extraParcelsText(cur.extraParcels), newValue: extraParcelsText(change.extraParcels) },
      ].filter((l) => l.oldValue !== l.newValue);
      if (logs.length) {
        await tx.changeLog.createMany({
          data: logs.map((l) => ({ ...l, targetTable: "properties", targetId: id, source: "manual" as const, changedBy: session.id })),
        });
      }
      await tx.comment.create({ data: { propertyId: id, authorId: session.id, body: change.comment.slice(0, 2000), parentId: null } });

      // 分けた/合わせた筆を選んでいた取引の選びを合わせる(物件の行のあとに取引の行)。
      // ⚠取引の行を id 順にロックしてから読む(取引の画面で選びを保存している途中の値を、古い選びで上書きしない)。
      await tx.$queryRaw`SELECT "id" FROM "deals" WHERE "property_id" = ${id}::uuid ORDER BY "id" FOR UPDATE`;
      const deals = await tx.deal.findMany({ where: { propertyId: id, targetParcels: { not: Prisma.DbNull } }, select: { id: true, targetParcels: true } });
      let retargeted = 0;
      for (const d of deals) {
        const next = retargetDealParcels(readTargetParcels(d.targetParcels), change);
        if (!next) continue;
        await tx.deal.update({ where: { id: d.id }, data: { targetParcels: next, version: { increment: 1 } } });
        retargeted += 1;
      }
      return { op: change.op, pieces: input.op === "split" ? input.pieces.length : input.keys.length, retargeted };
    });

    const detail = { parcels: done.pieces, retargetedDeals: done.retargeted };
    if (done.op === "split") {
      await writeAuditLog({ userId: session.id, action: "property_parcel_split", targetTable: "properties", targetId: id, detail });
    } else {
      await writeAuditLog({ userId: session.id, action: "property_parcel_merge", targetTable: "properties", targetId: id, detail });
    }
    return NextResponse.json({ version: input.version + 1, retargetedDeals: done.retargeted }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
