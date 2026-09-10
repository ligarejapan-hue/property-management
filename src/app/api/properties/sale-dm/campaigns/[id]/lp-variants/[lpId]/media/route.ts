import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma";
import { handleApiError, ApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmAccess, requireSaleDmWriteAccess, assertSaleDmCampaignOwned } from "@/lib/sale-dm-letter/route-guard";
import { SETTLED_DRAFT_STATUSES, isVariantFrozen } from "@/lib/sale-dm-letter/freeze";
import { lpBodyHeadings } from "@/lib/sale-dm-letter/lp-template";
import { isFigureKind } from "@/lib/sale-dm-letter/lp-figures";
import { validateMediaPlan, mediaPlanIssueMessage, referencedAssetIds, type MediaPlan } from "@/lib/sale-dm-letter/lp-media";
import { saleDmLpMediaPutSchema } from "@/lib/validators-sale-dm";

type Ctx = { params: Promise<{ id: string; lpId: string }> };
type MediaRow = { slot: string; heading: string | null; assetId: string | null; figureKind: string | null; sortOrder: number };

const ASSET_SELECT = { id: true, publicId: true, mime: true, width: true, height: true, bytes: true, label: true, createdAt: true, _count: { select: { media: true } } } as const;

/** DB行 → 枠。節は本文の小見出し順に並べ、行が無い節は media:null。 */
export function rowsToPlan(rows: MediaRow[], headings: string[]): MediaPlan {
  const hero = rows.find((r) => r.slot === "hero" && r.assetId);
  const byHeading = new Map(rows.filter((r) => r.slot === "section" && r.heading).map((r) => [r.heading as string, r] as const));
  return {
    hero: hero ? { assetId: hero.assetId as string } : null,
    sections: headings.map((heading) => {
      const r = byHeading.get(heading);
      const media = !r ? null : r.assetId ? { kind: "asset" as const, assetId: r.assetId } : r.figureKind && isFigureKind(r.figureKind) ? { kind: "figure" as const, figureKind: r.figureKind } : null;
      return { heading, media };
    }),
  };
}

/** 枠 → DB行(media:null の節は行を作らない)。 */
export function planToRows(lpVariantId: string, plan: MediaPlan): Prisma.DmLpVariantMediaCreateManyInput[] {
  const rows: Prisma.DmLpVariantMediaCreateManyInput[] = [];
  if (plan.hero) rows.push({ lpVariantId, slot: "hero", heading: null, assetId: plan.hero.assetId, figureKind: null, sortOrder: 0 });
  plan.sections.forEach((s, i) => {
    if (!s.media) return;
    rows.push({
      lpVariantId,
      slot: "section",
      heading: s.heading,
      assetId: s.media.kind === "asset" ? s.media.assetId : null,
      figureKind: s.media.kind === "figure" ? s.media.figureKind : null,
      sortOrder: i,
    });
  });
  return rows;
}

async function listAssets() {
  const rows = await prisma.dmLpAsset.findMany({ where: { deletedAt: null }, orderBy: { createdAt: "desc" }, select: ASSET_SELECT });
  return rows.map(({ _count, ...a }) => ({ ...a, referenced: _count.media > 0 }));
}

export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id, lpId } = await params;
    await assertSaleDmCampaignOwned(id, session.id);
    const v = await prisma.dmLpVariant.findFirst({ where: { id: lpId, campaignId: id }, select: { id: true, bodyText: true, templateFrozenAt: true } });
    if (!v) throw new ApiError(404, "指定されたLP型が見つかりません", "LP_VARIANT_NOT_FOUND");
    const [rows, settledCount, assets] = await Promise.all([
      prisma.dmLpVariantMedia.findMany({ where: { lpVariantId: lpId }, orderBy: { sortOrder: "asc" }, select: { slot: true, heading: true, assetId: true, figureKind: true, sortOrder: true } }),
      prisma.dmRecipientDraft.count({ where: { campaignId: id, lpVariantId: lpId, status: { in: [...SETTLED_DRAFT_STATUSES] } } }),
      listAssets(),
    ]);
    const headings = lpBodyHeadings(v.bodyText ?? "");
    return NextResponse.json(
      { plan: rowsToPlan(rows, headings), headings, frozen: isVariantFrozen({ templateFrozenAt: v.templateFrozenAt, settledCount }), assets },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * 枠の保存(設計 §2.3/§2.8)。template route と同じ順序: dm_lp_variants FOR UPDATE → 凍結なら 409
 * (写真図は初期化の例外なし=送付後は一切変えない)→ 本文の小見出しと照合 → 写真の実在 →
 * 担当範囲(field_staff は物件親行をロックして読み直す。送付済み宛先も含める=template と同じ理由)→ 行を入れ替え。
 */
export async function PUT(request: NextRequest, { params }: Ctx) {
  try {
    const { session } = await requireSaleDmWriteAccess();
    const { id, lpId } = await params;
    await assertSaleDmCampaignOwned(id, session.id);
    const plan = saleDmLpMediaPutSchema.parse(await parseJsonBody(request)) as MediaPlan;

    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM dm_lp_variants WHERE id = ${lpId}::uuid AND campaign_id = ${id}::uuid FOR UPDATE`;
      const v = await tx.dmLpVariant.findFirst({ where: { id: lpId, campaignId: id }, select: { id: true, bodyText: true, templateFrozenAt: true } });
      if (!v) throw new ApiError(404, "指定されたLP型が見つかりません", "LP_VARIANT_NOT_FOUND");
      if (!v.bodyText || v.bodyText.trim().length === 0) {
        throw new ApiError(409, "先に文章を保存してください(写真や図は本文の小見出しに付けます)", "TEMPLATE_MISSING");
      }
      const settledCount = await tx.dmRecipientDraft.count({ where: { campaignId: id, lpVariantId: lpId, status: { in: [...SETTLED_DRAFT_STATUSES] } } });
      if (isVariantFrozen({ templateFrozenAt: v.templateFrozenAt, settledCount })) {
        throw new ApiError(409, "送付実績のあるLP型の写真や図は変更できません。変えるときは新しいLP型を追加してください", "VARIANT_FROZEN");
      }
      const headings = lpBodyHeadings(v.bodyText);
      const issue = validateMediaPlan(plan, headings);
      if (issue) throw new ApiError(400, mediaPlanIssueMessage(issue), "INVALID_MEDIA_PLAN");
      const assetIds = referencedAssetIds(plan);
      if (assetIds.length > 0) {
        const found = await tx.dmLpAsset.findMany({ where: { id: { in: assetIds }, deletedAt: null }, select: { id: true } });
        if (found.length !== assetIds.length) throw new ApiError(422, "選んだ写真の一部が削除されています。選び直してください", "ASSET_NOT_FOUND");
      }
      if (session.role === "field_staff") {
        const targets = await tx.dmRecipientDraft.findMany({ where: { campaignId: id, lpVariantId: lpId }, select: { propertyId: true } });
        const propertyIds = [...new Set(targets.map((d) => d.propertyId))].sort();
        if (propertyIds.length > 0) {
          await tx.$queryRaw`SELECT id FROM properties WHERE id = ANY(${propertyIds}::uuid[]) ORDER BY id FOR UPDATE`;
          const visible = await tx.property.findMany({ where: { id: { in: propertyIds }, OR: [{ createdBy: session.id }, { assignedTo: session.id }] }, select: { id: true } });
          if (visible.length !== propertyIds.length) throw new ApiError(403, "担当外の宛先を含むLP型は写真や図を変更できません", "FORBIDDEN");
        }
      }
      const rows = planToRows(lpId, plan);
      await tx.dmLpVariantMedia.deleteMany({ where: { lpVariantId: lpId } });
      if (rows.length > 0) await tx.dmLpVariantMedia.createMany({ data: rows });
      return { headings, assetCount: assetIds.length, figureCount: rows.filter((r) => r.figureKind).length };
    });

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_lp_media_update",
      targetTable: "dm_lp_variants",
      targetId: lpId,
      // 非PII: 件数と日時のみ(見出し・ラベルは残さない)。
      detail: { campaignId: id, assetCount: result.assetCount, figureCount: result.figureCount, updatedAt: new Date().toISOString() },
    });
    return NextResponse.json({ plan, assetCount: result.assetCount, figureCount: result.figureCount }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
