import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireScenarioAdmin, lockScenarioForUpdate } from "@/lib/sale-dm-letter/scenario-guard";
import { letterIllustrationFromAsset } from "@/lib/sale-dm-letter/letter-illustration";

type Ctx = { params: Promise<{ id: string }> };

const putSchema = z.object({ assetId: z.string().uuid().nullable() });

/**
 * 台帳の手紙のイラストを選ぶ/外す(設計 2026-10-05 §5)。管理者だけ。
 * ロック順序は dm_scenarios → dm_lp_assets(scenarios/[id]/media と同じ並び)。写真の削除
 * (lp-assets/[assetId] DELETE)も写真行を FOR UPDATE してから数えるので、選ぶと消すがすれ違わない。
 */
export async function PUT(request: NextRequest, { params }: Ctx) {
  try {
    const { session } = await requireScenarioAdmin();
    const { id } = await params;
    const { assetId } = putSchema.parse(await parseJsonBody(request));

    const result = await prisma.$transaction(async (tx) => {
      await lockScenarioForUpdate(tx, id);
      const s = await tx.dmScenario.findUniqueOrThrow({ where: { id }, select: { letterIllustrationAssetId: true } });
      let asset: { publicId: string; width: number; height: number; deletedAt: Date | null } | null = null;
      if (assetId) {
        await tx.$queryRaw`SELECT id FROM dm_lp_assets WHERE id = ${assetId}::uuid FOR UPDATE`;
        asset = await tx.dmLpAsset.findFirst({
          where: { id: assetId, deletedAt: null },
          select: { publicId: true, width: true, height: true, deletedAt: true },
        });
        if (!asset) throw new ApiError(400, "その写真は削除されています。選び直してください", "ASSET_NOT_FOUND");
      }
      if (s.letterIllustrationAssetId === assetId) return { changed: false, asset };
      await tx.dmScenario.update({ where: { id }, data: { letterIllustrationAssetId: assetId } });
      return { changed: true, asset };
    });

    if (result.changed) {
      await writeAuditLog({
        userId: session.id,
        action: "sale_dm_scenario_letter_illustration_update",
        targetTable: "dm_scenarios",
        targetId: id,
        // 非PII: 付いたか外れたかだけ。
        detail: { hasIllustration: assetId !== null },
      });
    }
    return NextResponse.json(
      { letterIllustrationAssetId: assetId, letterIllustration: letterIllustrationFromAsset(result.asset) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
