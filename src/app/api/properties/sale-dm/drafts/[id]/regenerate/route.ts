import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import { hasPermission } from "@/lib/permissions";
import { isSaleDmConfigured, generateLetters } from "@/lib/sale-dm-letter";
import { resolveSender } from "@/lib/sale-dm-letter/sender";
import { resolveDraftOptions } from "@/lib/sale-dm-letter/override";
import { PROPERTY_TYPE_LABELS } from "@/lib/property-types";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { session, permissions } = await requireSaleDmAccess();
    // 再生成も有料AI呼び出し(1通)+ オーナーPII の外部送信のため sale_dm:generate を必須化(campaign 作成と統一)。
    if (!hasPermission(permissions, "sale_dm", "generate")) throw new ApiError(403, "AIによるDM生成の権限がありません", "FORBIDDEN");
    if (!isSaleDmConfigured()) throw new ApiError(503, "売却DM生成が未設定です", "NOT_CONFIGURED");
    const { id } = await params;
    const draft = await prisma.dmRecipientDraft.findUnique({ where: { id }, include: { variant: true, property: { select: { address: true, propertyType: true, roomNo: true, createdBy: true, assignedTo: true } }, campaign: { select: { createdBy: true } } } });
    // 作成者本人のキャンペーン配下のみ(横断アクセス防止)。not-found/not-owned は同じ 404。
    if (!draft || draft.campaign.createdBy !== session.id) throw new ApiError(404, "下書きが見つかりません", "NOT_FOUND");
    // field_staff は作成 or 担当の物件のみ操作可(物件APIと同じ record scope。再割当で範囲外に
    // なった物件の宛先PIIを生成器へ渡させない)。GET/print/export の絞り込みと整合。
    if (
      session.role === "field_staff" &&
      draft.property.createdBy !== session.id &&
      draft.property.assignedTo !== session.id
    ) {
      throw new ApiError(403, "この物件を操作する権限がありません", "FORBIDDEN");
    }
    // 送付済み(sent)の宛先は再生成(本文書き換え)できない(送った内容/集計の改竄防止)。
    if (draft.status === "sent") throw new ApiError(409, "送付済みの宛先は再生成できません", "ALREADY_SENT");
    const v = draft.variant;
    const sender = resolveSender();
    const { drafts } = await generateLetters([{
      recipient: {
        representativeName: draft.recipientName, honorific: draft.honorific, coOwnerCount: draft.coOwnerCount,
        propertyAddress: draft.property.address, propertyTypeLabel: PROPERTY_TYPE_LABELS[draft.property.propertyType] ?? draft.property.propertyType, roomNo: draft.property.roomNo,
      },
      // 割り当てられた型(variant)の設定に、この通だけの個別上書き(overrideJson)を
      // merge して options を組み立てる(集計は variantId 基準・override は本文の微修正のみ)。
      options: resolveDraftOptions(
        { designTemplate: v.designTemplate, tone: v.tone, length: v.length, appeal: v.appeal, strength: v.strength, extraInstruction: v.extraInstruction },
        draft.overrideJson as Parameters<typeof resolveDraftOptions>[1],
        sender,
      ),
    }]);
    const body = drafts[0]?.body;
    if (!body) throw new ApiError(502, "再生成に失敗しました", "GENERATION_FAILED");
    // 生成は外部呼び出しで時間がかかるため、pre-check 後に並行で sent 確定し得る。
    // 条件付き updateMany で送付済みの本文を上書きしない(送信済み内容/集計の不変性)。0 行なら 409。
    // 本文が変わるため確定も解除(draft へ・confirmedAt 消去)。再生成後の新文面を再確認なしで
    // 印刷/送付させない("OK→確定→印刷/送付"の承認ゲートを維持・確定済み再生成の素通り防止)。
    const updated = await prisma.dmRecipientDraft.updateMany({ where: { id, status: { not: "sent" } }, data: { body, status: "draft", confirmedAt: null } });
    if (updated.count === 0) {
      throw new ApiError(409, "送付済みの宛先は再生成できません", "ALREADY_SENT");
    }
    return NextResponse.json({ id, body }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return handleApiError(error); }
}
