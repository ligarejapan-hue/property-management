import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@/generated/prisma";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmAccess, assertSaleDmCampaignOwned } from "@/lib/sale-dm-letter/route-guard";
import { saleDmVariantUpdateSchema } from "@/lib/validators-sale-dm";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string; variantId: string }> }) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id, variantId } = await params;
    await assertSaleDmCampaignOwned(id, session.id); // 作成者本人のキャンペーンの型のみ更新可。
    const parsed = saleDmVariantUpdateSchema.parse(await parseJsonBody(request));

    // 当該キャンペーンに存在する型のみ更新可。stale/削除済み id は Prisma P2025→500 でなく 404 に。
    // 既存の option 値も取得し、送信値と比較して「実際に変わった」ときだけ無効化する(下記)。
    const existing = await prisma.dmVariant.findFirst({
      where: { id: variantId, campaignId: id },
      select: { id: true, designTemplate: true, tone: true, length: true, appeal: true, strength: true, extraInstruction: true },
    });
    if (!existing) {
      throw new ApiError(404, "指定された型が見つかりません", "VARIANT_NOT_FOUND");
    }

    const data: Prisma.DmVariantUpdateInput = {};
    if (parsed.label !== undefined) data.label = parsed.label;
    // options は指定項目を反映しつつ、既存値と異なる場合のみ optionFieldChanged=true にする。
    // full-form UI が現在値ごと再送する no-op 保存(や空 options)で生成/承認済みの本文を消さないため、
    // 「項目が来たか」ではなく「値が実際に変わったか」で無効化を判定する。
    let optionFieldChanged = false;
    if (parsed.options) {
      const o = parsed.options;
      if (o.designTemplate !== undefined) { data.designTemplate = o.designTemplate; if (o.designTemplate !== existing.designTemplate) optionFieldChanged = true; }
      if (o.tone !== undefined) { data.tone = o.tone; if (o.tone !== existing.tone) optionFieldChanged = true; }
      if (o.length !== undefined) { data.length = o.length; if (o.length !== existing.length) optionFieldChanged = true; }
      if (o.appeal !== undefined) { data.appeal = o.appeal; if (o.appeal !== existing.appeal) optionFieldChanged = true; }
      if (o.strength !== undefined) { data.strength = o.strength; if (o.strength !== existing.strength) optionFieldChanged = true; }
      // 空文字と null は「追加指示なし」で等価。label のみ変更でもフォームは extraInstruction:"" を送るため、
      // ""↔null の差を「変更」とみなして生成/確定済みの本文を消さない(両辺を "" に正規化して比較)。
      if (o.extraInstruction !== undefined) { const next = o.extraInstruction ?? null; data.extraInstruction = next; if ((next ?? "") !== (existing.extraInstruction ?? "")) optionFieldChanged = true; }
    }

    // field_staff は campaign-level の型 options 変更で「担当外(再割当で隠れた)の未送付下書き」の本文まで
    // 無効化してしまう(型は campaign 横断で多数の宛先に共有)。GET/print/export/aggregate の scope 絞り込みと
    // 整合させるため、担当外の未送付下書きが1件でもあれば options 変更を拒否する(label のみ=本文不変は許可)。
    if (optionFieldChanged && session.role === "field_staff") {
      const outOfScope = await prisma.dmRecipientDraft.count({
        where: {
          campaignId: id,
          variantId,
          status: { not: "sent" },
          // 「担当外」= 可視条件(createdBy==me OR assignedTo==me)の否定。assignedTo が NULL の未割当物件も
          // 担当外として数える必要があるため、`{not}` の AND ではなく NOT(OR) を使う(SQL では `assignedTo != me`
          // が NULL にマッチせず取りこぼす)。filterDraftsByFieldStaffScope の可視判定と厳密に一致させる。
          property: { NOT: { OR: [{ createdBy: session.id }, { assignedTo: session.id }] } },
        },
      });
      if (outOfScope > 0) {
        throw new ApiError(403, "担当外の宛先を含む型は設定を変更できません", "FORBIDDEN");
      }
    }

    // 送付済みの宛先が使っている型は設定変更不可(送付後に設計/トーン/訴求やラベルを変えると CSV・送付履歴・
    // A/B 集計が実際に送った構成と食い違う)。sent チェック→型更新→下書き無効化を 1 トランザクションにまとめ、
    // 前後で sent を数えることで mark-sent との競合(TOCTOU=チェック後に別 request が sent 化)を検出し
    // ロールバックする(凍結=送った構成の不変性を守る)。
    const result = await prisma.$transaction(async (tx) => {
      // mark-sent との TOCTOU(label/設定変更が送付確定と競合し、送付後に型が変わって A/B 履歴・送付履歴が
      // 食い違う)を防ぐため、この型の宛先行を FOR UPDATE でロックして mark-sent と直列化する。sentBefore/
      // sentAfter のみでは mark-sent の未コミット更新を見落とす(label のみ編集は下書き行に触れずロックもしない)。
      // ロック後はどちらの順序でも整合(編集→送付=送付時点の型で送る / 送付→編集=sent検知で VARIANT_LOCKED)。
      await tx.$queryRaw`SELECT id FROM dm_recipient_drafts WHERE campaign_id = ${id}::uuid AND variant_id = ${variantId}::uuid FOR UPDATE`;
      const sentBefore = await tx.dmRecipientDraft.count({ where: { campaignId: id, variantId, status: "sent" } });
      if (sentBefore > 0) {
        throw new ApiError(409, "送付済みの宛先がある型は設定を変更できません(A/B履歴の整合のため)", "VARIANT_LOCKED");
      }
      // campaignId で縛り、他キャンペーンの型を更新させない。
      const updated = await tx.dmVariant.update({ where: { id: variantId, campaignId: id }, data });
      // options(design/tone/length/appeal/strength/extraInstruction)を実際に変えたら、この型を使う未送付の
      // 下書きは旧設定で生成済みのため無効化(本文クリア→draft へ・要再生成)。label のみ/空 options は本文不変。
      if (optionFieldChanged) {
        await tx.dmRecipientDraft.updateMany({
          where: { campaignId: id, variantId, status: { not: "sent" }, body: { not: "" } },
          data: { body: "", status: "draft", confirmedAt: null },
        });
      }
      // 更新中に別 request がこの型の宛先を sent 化していたら、送った構成を書き換えたことになる → ロールバック。
      const sentAfter = await tx.dmRecipientDraft.count({ where: { campaignId: id, variantId, status: "sent" } });
      if (sentAfter > 0) {
        throw new ApiError(409, "送付済みの宛先がある型は設定を変更できません(A/B履歴の整合のため)", "VARIANT_LOCKED");
      }
      return updated;
    });

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_variant_update",
      targetTable: "dm_variants",
      targetId: variantId,
      detail: { campaignId: id, fields: Object.keys(data), updatedAt: new Date().toISOString() },
    });

    return NextResponse.json({ variant: result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; variantId: string }> }) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id, variantId } = await params;
    await assertSaleDmCampaignOwned(id, session.id); // 作成者本人のキャンペーンの型のみ削除可。

    // 当該キャンペーンに存在する型のみ削除可。stale/削除済み id は Prisma P2025→500 でなく 404 に。
    const exists = await prisma.dmVariant.findFirst({ where: { id: variantId, campaignId: id }, select: { id: true } });
    if (!exists) {
      throw new ApiError(404, "指定された型が見つかりません", "VARIANT_NOT_FOUND");
    }

    // A/B 純度: 割当済みの下書きがある型は削除できない(別型へ移してから)。count→delete の TOCTOU
    // (チェックと削除の間に assign が下書きをこの型へ割り当てると、削除済み variant を参照する孤児 draft が
    // 残り A/B 集計から恒久的に消える)を避けるため、関係フィルタ `recipients: { none: {} }` で「下書きを
    // 1件も持たない場合のみ削除」をアトミックに実行する。0 行 = 割当済み(または並行割当の発生)→ 409。
    const deleted = await prisma.dmVariant.deleteMany({
      where: { id: variantId, campaignId: id, recipients: { none: {} } },
    });
    if (deleted.count === 0) {
      throw new ApiError(409, "この型は宛先に割り当てられているため削除できません", "VARIANT_IN_USE");
    }

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_variant_delete",
      targetTable: "dm_variants",
      targetId: variantId,
      detail: { campaignId: id, deletedAt: new Date().toISOString() },
    });

    return NextResponse.json({ deleted: variantId }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
