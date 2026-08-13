import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import { handleApiError, ApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmWriteAccess } from "@/lib/sale-dm-letter/route-guard";
import { markVariantsFrozen } from "@/lib/sale-dm-letter/freeze";
import { saleDmOptionsOverrideSchema } from "@/lib/validators-sale-dm";
import {
  letterBodyIssueMessage,
  validateLetterBody,
} from "@/lib/sale-dm-letter/body-validation";

// body / variantId / override の部分更新。最低1フィールドは必須。
const patchSchema = z
  .object({
    body: z.string().min(1).optional(),
    variantId: z.string().uuid().optional(),
    override: saleDmOptionsOverrideSchema.nullable().optional(),
  })
  .refine(
    (v) => v.body !== undefined || v.variantId !== undefined || v.override !== undefined,
    { message: "更新する項目がありません(body / variantId / override のいずれかが必要です)" },
  );

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { session } = await requireSaleDmWriteAccess();
    const { id } = await params;
    const parsed = patchSchema.parse(await parseJsonBody(request));

    const draft = await prisma.dmRecipientDraft.findUnique({
      where: { id },
      select: {
        id: true,
        campaignId: true,
        status: true,
        variantId: true,
        campaign: { select: { createdBy: true } },
        property: { select: { createdBy: true, assignedTo: true } },
      },
    });
    // 作成者本人のキャンペーン配下のみ操作可(横断アクセス防止)。not-found/not-owned は同じ 404。
    if (!draft || draft.campaign.createdBy !== session.id) {
      throw new ApiError(404, "下書きが見つかりません", "NOT_FOUND");
    }
    // field_staff は作成 or 担当の物件の宛先のみ編集可(regenerate/mark-sent/outcome と同じ record scope)。
    // campaign 作成後に物件が別担当へ再割当されると GET/print/export では隠れるため、本文/型/上書きの
    // 直接編集も同様に塞ぐ(stale な draft id での隠れ宛先改変を防ぐ)。
    if (
      session.role === "field_staff" &&
      draft.property.createdBy !== session.id &&
      draft.property.assignedTo !== session.id
    ) {
      throw new ApiError(403, "この宛先を操作する権限がありません", "FORBIDDEN");
    }
    // 送付済み(sent)の宛先は本文・型・上書きを編集できない(送った内容/集計の改竄防止)。
    if (draft.status === "sent") {
      throw new ApiError(409, "送付済みの宛先は編集できません", "ALREADY_SENT");
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: Record<string, any> = {};

    if (parsed.body !== undefined) {
      // 本文の検証は貼り付け・一括適用(PR-D2)と同じ関数を通す。1宛先ずつの編集で
      // 迂回できると、白紙やプレースホルダ入りの手紙がそのまま印刷・郵送される。
      const issue = validateLetterBody(parsed.body);
      if (issue) throw new ApiError(400, letterBodyIssueMessage(issue), "INVALID_BODY");
      data.body = parsed.body;
      // 確定済みの本文を直接編集したら確定を解除(draft へ・confirmedAt 消去)。承認した文面と
      // 実際に印刷/送付する文面を一致させ、本文変更で "OK→確定→印刷/送付" の承認ゲートを迂回させない。
      data.status = "draft";
      data.confirmedAt = null;
    }

    if (parsed.variantId !== undefined) {
      // 付け替え先は同一 campaign の型に限る(他キャンペーンの型を割り当てさせない)。
      const variant = await prisma.dmVariant.findFirst({
        where: { id: parsed.variantId, campaignId: draft.campaignId },
        select: { id: true },
      });
      if (!variant) throw new ApiError(404, "指定された型が見つかりません", "VARIANT_NOT_FOUND");
      data.variantId = parsed.variantId;
    }

    // override は明示 null で消去(DB NULL=Prisma.DbNull)、object で保存。undefined は不変。
    // 注: nullable Json フィールドへ素の JS null を渡すと Prisma は実行時に拒否するため
    //     消去は必ず Prisma.DbNull を使う(read 時は overrideJson: null として返る)。
    if (parsed.override !== undefined) {
      data.overrideJson = parsed.override === null ? Prisma.DbNull : parsed.override;
    }

    // 型を別 variant へ変える際、本文を同時指定していなければ本文をクリア(=要再生成・status を
    // draft へ・confirmedAt 消去)。旧 variant の作風のまま新ラベルで送る A/B 不一致を防ぐ(bulk assign と統一)。
    if (parsed.variantId !== undefined && parsed.variantId !== draft.variantId && parsed.body === undefined) {
      data.body = "";
      data.status = "draft";
      data.confirmedAt = null;
    }

    // 状態遷移をアトミックに行う: pre-check 後に並行で sent 確定した場合(別タブ/一括送付)は
    // 0 行となり stale 編集を弾く(送信済みの本文/型/上書き=A/B割付・集計の不変性を守る)。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // ⚠確定を戻す（本文編集）／別の型へ移す前に、いまの型へ凍結印を立てる（設計 §2.4）。
    //   どちらも「その型に確定があった」証拠を消すので、消える前に列へ固定する。
    const resetsConfirmation =
      data.status === "draft" || parsed.variantId !== undefined;
    if (resetsConfirmation && draft.status === "confirmed") {
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM dm_variants WHERE id = ${draft.variantId}::uuid FOR UPDATE`;
        await markVariantsFrozen(tx, [draft.variantId]);
      });
    }

    const result = await prisma.dmRecipientDraft.updateMany({ where: { id, status: { not: "sent" } }, data: data as any });
    if (result.count === 0) {
      throw new ApiError(409, "送付済みの宛先は編集できません", "ALREADY_SENT");
    }

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_draft_update",
      targetTable: "dm_recipient_drafts",
      targetId: id,
      // 非PII: 何を更新したかのキー名のみ(本文・override 内容は残さない)。
      detail: { campaignId: draft.campaignId, fields: Object.keys(data), updatedAt: new Date().toISOString() },
    });

    return NextResponse.json({ id }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
