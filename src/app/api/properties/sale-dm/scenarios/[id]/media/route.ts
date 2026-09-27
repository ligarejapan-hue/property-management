import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireScenarioAdmin, lockScenarioForUpdate } from "@/lib/sale-dm-letter/scenario-guard";
import { lpBodyHeadings } from "@/lib/sale-dm-letter/lp-template";
import { validateMediaPlan, mediaPlanIssueMessage, referencedAssetIds, type MediaPlan } from "@/lib/sale-dm-letter/lp-media";
import { rowsToPlan, planToRows } from "@/lib/sale-dm-letter/lp-media-rows";
import { saleDmLpMediaPutSchema } from "@/lib/validators-sale-dm";
import { ASSET_REFERENCE_COUNT_SELECT, isAssetReferenced } from "@/lib/sale-dm-letter/asset-references";

type Ctx = { params: Promise<{ id: string }> };

const ASSET_SELECT = { id: true, publicId: true, mime: true, width: true, height: true, bytes: true, label: true, createdAt: true, ...ASSET_REFERENCE_COUNT_SELECT } as const;

async function listAssets() {
  const rows = await prisma.dmLpAsset.findMany({ where: { deletedAt: null }, orderBy: { createdAt: "desc" }, select: ASSET_SELECT });
  return rows.map(({ _count, ...a }) => ({ ...a, referenced: isAssetReferenced({ _count }) }));
}

/**
 * 台帳のLPの写真と図の枠(設計 §2.3/§2.8/§3.6)。lp-variants/[lpId]/media と同じ形だが、
 * 台帳には凍結・宛先・担当範囲という概念が無いので、それらの検査は行わない
 * (中身の読み書きは管理者だけ=requireScenarioAdmin)。
 */
export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    await requireScenarioAdmin();
    const { id } = await params;
    const s = await prisma.dmScenario.findFirst({ where: { id, deletedAt: null }, select: { lpBodyText: true } });
    if (!s) throw new ApiError(404, "DMの種類が見つかりません", "SCENARIO_NOT_FOUND");
    const [rows, assets] = await Promise.all([
      prisma.dmScenarioMedia.findMany({ where: { scenarioId: id }, orderBy: { sortOrder: "asc" }, select: { slot: true, heading: true, assetId: true, figureKind: true, sortOrder: true } }),
      listAssets(),
    ]);
    // 同じ小見出しが本文に2回あると節が2件になり枠の保存が壊れるため、重複は1件にまとめる。
    const headings = [...new Set(lpBodyHeadings(s.lpBodyText ?? ""))];
    // rowsToPlan は保存済みの行だけを返す(パディングしない)ので、本文の全小見出しへ
    // 展開するのはここで行う(行が無い見出しは media:null)。
    const rowPlan = rowsToPlan(rows);
    const bySection = new Map(rowPlan.sections.map((sec) => [sec.heading, sec.media] as const));
    const plan: MediaPlan = { hero: rowPlan.hero, sections: headings.map((heading) => ({ heading, media: bySection.get(heading) ?? null })) };
    return NextResponse.json({ plan, headings, assets }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * 枠の保存(設計 §2.3/§2.8/§3.6)。ロック順序は dm_scenarios → dm_lp_assets
 * (lp-variants/[lpId]/media と同じ並びで、この route での最終段が dm_lp_assets)。
 * 台帳を書き換える経路は必ず先に dm_scenarios を FOR UPDATE でロックする(設計 §3.3.1)。
 */
export async function PUT(request: NextRequest, { params }: Ctx) {
  try {
    const { session } = await requireScenarioAdmin();
    const { id } = await params;
    const plan = saleDmLpMediaPutSchema.parse(await parseJsonBody(request)) as MediaPlan;

    const result = await prisma.$transaction(async (tx) => {
      await lockScenarioForUpdate(tx, id);
      const s = await tx.dmScenario.findUniqueOrThrow({ where: { id } });
      if (!s.lpBodyText || s.lpBodyText.trim().length === 0) {
        throw new ApiError(409, "先に文章を保存してください(写真や図は本文の小見出しに付けます)", "TEMPLATE_MISSING");
      }
      // 同じ小見出しが本文に2回あると節が2件になり枠の保存が壊れるため、重複は1件にまとめる。
      const headings = [...new Set(lpBodyHeadings(s.lpBodyText))];
      const issue = validateMediaPlan(plan, headings);
      if (issue) throw new ApiError(400, mediaPlanIssueMessage(issue), "INVALID_MEDIA_PLAN");
      const assetIds = referencedAssetIds(plan);
      if (assetIds.length > 0) {
        // dm_lp_assets はこの route のロック順序の最終段。削除(lp-assets/[assetId] DELETE)と
        // 競合させないため、実在確認の前に対象行を FOR UPDATE でロックする。
        await tx.$queryRaw`SELECT id FROM dm_lp_assets WHERE id = ANY(${assetIds}::uuid[]) ORDER BY id FOR UPDATE`;
        const found = await tx.dmLpAsset.findMany({ where: { id: { in: assetIds }, deletedAt: null }, select: { id: true } });
        if (found.length !== assetIds.length) throw new ApiError(409, "選んだ写真の一部が削除されています。選び直してください", "ASSET_NOT_FOUND");
      }
      // planToRows は外部キー列を持たない汎用行を返すので、ここで scenarioId を足す。
      const rows = planToRows(plan).map((r) => ({ ...r, scenarioId: id }));
      await tx.dmScenarioMedia.deleteMany({ where: { scenarioId: id } });
      if (rows.length > 0) await tx.dmScenarioMedia.createMany({ data: rows });
      return { assetCount: assetIds.length, figureCount: rows.filter((r) => r.figureKind).length };
    });

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_scenario_media_update",
      targetTable: "dm_scenarios",
      targetId: id,
      // 非PII: 件数だけ(見出し・ラベルは残さない)。
      detail: { assetCount: result.assetCount, figureCount: result.figureCount },
    });
    return NextResponse.json({ plan, assetCount: result.assetCount, figureCount: result.figureCount }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
