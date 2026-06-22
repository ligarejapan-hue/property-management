import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import { saleDmAssignSchema } from "@/lib/validators-sale-dm";
import { assignVariantsEvenly, applyManualAssignment } from "@/lib/sale-dm-letter/assign";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id } = await params;
    const body = saleDmAssignSchema.parse(await parseJsonBody(request));

    const [variants, recipients] = await Promise.all([
      prisma.dmVariant.findMany({ where: { campaignId: id }, select: { id: true }, orderBy: { label: "asc" } }),
      prisma.dmRecipientDraft.findMany({ where: { campaignId: id }, select: { id: true }, orderBy: { id: "asc" } }),
    ]);

    if (variants.length === 0) {
      throw new ApiError(409, "割り当てる型がありません(先に型を作成してください)", "NO_VARIANTS");
    }

    const variantIds = variants.map((v) => v.id);
    const recipientIds = recipients.map((r) => r.id);

    const assignment =
      body.mode === "manual"
        ? applyManualAssignment(recipientIds, variantIds, body.assignments ?? [])
        : assignVariantsEvenly(recipientIds, variantIds, { order: body.order ?? "sequential" });

    // variantId ごとに recipient id をまとめ、型ごとに 1 回の updateMany で反映(N+1 回避)。
    const byVariant = new Map<string, string[]>();
    for (const [recipientId, variantId] of assignment) {
      const bucket = byVariant.get(variantId);
      if (bucket) bucket.push(recipientId);
      else byVariant.set(variantId, [recipientId]);
    }

    let assigned = 0;
    const perVariant: Record<string, number> = {};
    for (const [variantId, ids] of byVariant) {
      if (ids.length === 0) continue;
      const result = await prisma.dmRecipientDraft.updateMany({
        where: { id: { in: ids }, campaignId: id },
        data: { variantId },
      });
      assigned += result.count;
      perVariant[variantId] = result.count;
    }

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_assign_variants",
      targetTable: "dm_recipient_drafts",
      detail: { campaignId: id, mode: body.mode, order: body.order ?? null, assigned, perVariant, assignedAt: new Date().toISOString() },
    });

    return NextResponse.json({ assigned, perVariant }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
