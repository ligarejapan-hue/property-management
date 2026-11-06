import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { supportsUnitFields } from "@/lib/property-building-name";
import { requireDeal, DEAL_VERSION_CONFLICT_MESSAGE } from "@/lib/deals/guard";
import { buildSnapshotFromProperty, readSnapshot, SNAPSHOT_PROPERTY_SELECT } from "@/lib/deals/snapshot";
import { syncDealScheduleSafe } from "@/lib/deals/schedule-sync";
import { applyTargetParcels, dealParcelOptions, normalizeTargetParcels, readTargetParcels } from "@/lib/deals/target-parcels";

type Ctx = { params: Promise<{ id: string }> };
const bodySchema = z.object({
  version: z.number().int().positive(),
  /** null=全部。 */
  targetParcels: z.array(z.string().min(1).max(64)).max(64).nullable(),
}).strict();

/**
 * この取引の土地・建物を保存する(2026-11-06 発注者 案A 3回目)。
 * 選んだものに合わせて、写しの所在・地番と家屋番号だけを物件の今の値で入れ直す(ほかの写しの項目は触らない)。
 * 照合・段取り・書類確認書の謄本の見方も、選んだものだけになる(段取りはここで読み直す)。
 * ⚠物件を見られる人だけ(選ぶ一覧は物件の地番そのもの)。区分の物件・足した行の無い物件では選べない。
 */
export async function POST(request: Request, ctx: Ctx) {
  try {
    const { session, perms } = await requireDeal("write");
    const id = z.string().uuid().parse((await ctx.params).id);
    const { version, targetParcels } = bodySchema.parse(await parseJsonBody(request));
    if (!hasPermission(perms, "property", "read")) throw new ApiError(403, "物件を見る権限がありません", "FORBIDDEN");

    const count = await prisma.$transaction(async (tx) => {
      const deal = await tx.deal.findUnique({ where: { id }, select: { propertyId: true, propertySnapshot: true, version: true, targetParcels: true } });
      if (!deal) throw new ApiError(404, "取引が見つかりません", "NOT_FOUND");
      if (deal.version !== version) throw new ApiError(409, DEAL_VERSION_CONFLICT_MESSAGE, "VERSION_CONFLICT");
      if (!deal.propertyId) throw new ApiError(422, "手入力の物件の取引です", "NO_PROPERTY");
      const p = await tx.property.findUnique({ where: { id: deal.propertyId }, select: SNAPSHOT_PROPERTY_SELECT });
      if (!p || !canAccessPropertyRecord(session, p)) throw new ApiError(404, "物件が見つかりません", "PROPERTY_NOT_FOUND");
      // 選んでいる取引は、足した行が無くなっても選び直せる(全部に戻すなど・@codex P1)。
      const options = supportsUnitFields(p.propertyType) ? [] : dealParcelOptions(p, { always: !!readTargetParcels(deal.targetParcels) });
      const picked = normalizeTargetParcels(targetParcels, options);
      // 物件に無い行・空の選択は黙って全部にしない(別の筆の書類を作らない)。
      if (!picked.ok) throw new ApiError(422, "この取引の土地・建物を選び直してください", "UNKNOWN_PARCEL");

      const fresh = buildSnapshotFromProperty({ ...p, ...applyTargetParcels(p, picked.value) });
      const res = await tx.deal.updateMany({
        where: { id, version },
        data: {
          targetParcels: picked.value ?? Prisma.DbNull,
          propertySnapshot: { ...readSnapshot(deal.propertySnapshot), lotNumber: fresh.lotNumber, buildingNumber: fresh.buildingNumber },
          version: { increment: 1 },
        },
      });
      if (res.count === 0) throw new ApiError(409, DEAL_VERSION_CONFLICT_MESSAGE, "VERSION_CONFLICT");
      return picked.value?.length ?? null;
    });

    // 担保の項目は選んだ筆・棟の謄本で決め直す(失敗しても保存は止めない)。
    await syncDealScheduleSafe(id, { userId: session.id });
    // ⚠地番は監査に出さない(選んだ数だけ)。
    await writeAuditLog({
      userId: session.id, action: "deal_target_parcels", targetTable: "deals", targetId: id,
      detail: { selected: count ?? "all" },
    });
    return NextResponse.json({ version: version + 1 }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
