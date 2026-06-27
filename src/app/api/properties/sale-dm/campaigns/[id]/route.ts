import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError } from "@/lib/api-helpers";
import { requireSaleDmAccess, filterDraftsByFieldStaffScope } from "@/lib/sale-dm-letter/route-guard";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id } = await params;
    const campaign = await prisma.dmCampaign.findUnique({
      where: { id },
      include: {
        variants: true,
        recipients: {
          orderBy: { createdAt: "asc" },
          include: { property: { select: { createdBy: true, assignedTo: true } } },
        },
      },
    });
    // 作成者本人のキャンペーンのみ返す(他人 UUID での横断アクセス=範囲外の宛先PII漏洩を防ぐ)。
    // 見つからない/他人のものは同じ 404 にして存在を漏らさない。
    if (!campaign || campaign.createdBy !== session.id) {
      return NextResponse.json({ error: { code: "NOT_FOUND" } }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    // field_staff は現在の物件 record scope(作成/担当)の宛先PIIのみ返す。物件が別担当へ
    // 再割当されたら、自分が作成したキャンペーンでもその宛先(氏名/住所/本文)は出さない。
    const visible = filterDraftsByFieldStaffScope(campaign.recipients, session);
    // scope 判定用に引いた property は応答に載せない(元の recipient 形へ戻す)。
    const recipients = visible.map((r) => {
      const { property, ...rest } = r;
      void property;
      return rest;
    });
    return NextResponse.json(
      { campaign: { ...campaign, recipients } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) { return handleApiError(error); }
}
