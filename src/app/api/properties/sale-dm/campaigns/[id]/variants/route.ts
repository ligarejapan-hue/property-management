import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmAccess, assertSaleDmCampaignOwned } from "@/lib/sale-dm-letter/route-guard";
import { saleDmVariantCreateSchema } from "@/lib/validators-sale-dm";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id } = await params;
    await assertSaleDmCampaignOwned(id, session.id); // 作成者本人のキャンペーンの型のみ一覧。
    const variants = await prisma.dmVariant.findMany({
      where: { campaignId: id },
      orderBy: { label: "asc" },
    });
    return NextResponse.json({ variants }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id } = await params;
    const { label, options, lpUrl } = saleDmVariantCreateSchema.parse(await parseJsonBody(request));

    const campaign = await prisma.dmCampaign.findUnique({ where: { id }, select: { id: true, createdBy: true } });
    // 作成者本人のキャンペーンにのみ型を作成可(横断アクセス防止)。not-found/not-owned は 404。
    if (!campaign || campaign.createdBy !== session.id) throw new ApiError(404, "キャンペーンが見つかりません", "NOT_FOUND");

    const variant = await prisma.dmVariant.create({
      data: {
        campaignId: id,
        label,
        designTemplate: options.designTemplate,
        tone: options.tone,
        length: options.length,
        appeal: options.appeal,
        strength: options.strength,
        extraInstruction: options.extraInstruction ?? null,
        // 型ごとLP(未指定は null=既定 SALE_DM_LP_URL へフォールバック)。
        lpUrl: lpUrl ?? null,
      },
    });

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_variant_create",
      targetTable: "dm_variants",
      targetId: variant.id,
      // label は operator 自由記述(PII混入し得る)。AuditLog detail には保存しない(redact でなく非保存)。
      // 追跡は campaignId + targetId(=variant.id)で足りる。
      detail: { campaignId: id, createdAt: new Date().toISOString() },
    });

    return NextResponse.json({ variant }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
