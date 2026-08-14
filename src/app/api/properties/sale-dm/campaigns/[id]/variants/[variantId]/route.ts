import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@/generated/prisma";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmWriteAccess, assertSaleDmCampaignOwned } from "@/lib/sale-dm-letter/route-guard";
import { saleDmVariantUpdateSchema } from "@/lib/validators-sale-dm";
import { SETTLED_DRAFT_STATUSES, isVariantFrozen } from "@/lib/sale-dm-letter/freeze";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string; variantId: string }> }) {
  try {
    const { session } = await requireSaleDmWriteAccess();
    const { id, variantId } = await params;
    await assertSaleDmCampaignOwned(id, session.id); // 作成者本人のキャンペーンの型のみ更新可。
    const parsed = saleDmVariantUpdateSchema.parse(await parseJsonBody(request));

    // 当該キャンペーンに存在する型のみ更新可。stale/削除済み id は Prisma P2025→500 でなく 404 に。
    // 既存の option 値も取得し、送信値と比較して「実際に変わった」ときだけ無効化する(下記)。
    const existing = await prisma.dmVariant.findFirst({
      where: { id: variantId, campaignId: id },
      select: { id: true, designTemplate: true, tone: true, length: true, appeal: true, strength: true, extraInstruction: true, lpUrl: true },
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
    // 印刷デザインは「本文を失効させないが、担当外の宛先の印刷結果は変える」ので別枠。
    let designChanged = false;
    if (parsed.options) {
      const o = parsed.options;
      // ⚠**印刷デザインは失効の契機にしない**（@codex #376 R8）。デザインは印刷時に別途
      //   あてがわれる見た目の設定で、外部AI方式のプロンプト（設計 §2.2）には含めない
      //   ＝変えても文面は変わらない。にもかかわらず失効させると、原本・プロンプトの控え・
      //   全下書きの本文が「得るもの無しに」消える（追加の指示と同じ型の穴）。
      //   ただし**この型の全宛先（担当外で見えない宛先を含む）の印刷結果を変える**ので、
      //   field_staff の担当範囲チェックは lpUrl と同じく要求する。
      if (o.designTemplate !== undefined) { data.designTemplate = o.designTemplate; if (o.designTemplate !== existing.designTemplate) designChanged = true; }
      if (o.tone !== undefined) { data.tone = o.tone; if (o.tone !== existing.tone) optionFieldChanged = true; }
      if (o.length !== undefined) { data.length = o.length; if (o.length !== existing.length) optionFieldChanged = true; }
      if (o.appeal !== undefined) { data.appeal = o.appeal; if (o.appeal !== existing.appeal) optionFieldChanged = true; }
      if (o.strength !== undefined) { data.strength = o.strength; if (o.strength !== existing.strength) optionFieldChanged = true; }
      // 空文字と null は「追加指示なし」で等価。label のみ変更でもフォームは extraInstruction:"" を送るため、
      // ""↔null の差を「変更」とみなして生成/確定済みの本文を消さない(両辺を "" に正規化して比較)。
      // ⚠**追加の指示は失効の契機にしない**（設計 §2.4 @codex R46 / #376 R3）。外部AI方式の
      //   プロンプトはこの欄を含めないので、変えても文面は変わらない。にもかかわらず失効させると、
      //   原本・プロンプトの控え・全下書きの本文が「得るもの無しに」消える。値は保存だけする。
      if (o.extraInstruction !== undefined) { data.extraInstruction = o.extraInstruction ?? null; }
    }
    // 型ごとLP は本文に影響しない(QR は /t/<token> で、遷移先はスキャン時に型の lpUrl から解決)。
    // よって optionFieldChanged にはせず、未送付下書きの本文を消さない(要再生成にしない)。null=既定LPへ戻す。
    // ただし送付済みの型は下の sent チェックで全更新が 409 になり、送付済みの A/B LP 構成も凍結される。
    // lpUrl が「実際に」変わったか(field_staff scope 判定に使う。lpUrl は公開 /t/ の転送先=この型の全宛先
    // [担当外の隠れ宛先含む]の遷移先を変えるため、本文非無効化でも option 変更と同じ scope を要求する)。
    const lpUrlChanged = parsed.lpUrl !== undefined && (parsed.lpUrl ?? null) !== (existing.lpUrl ?? null);
    if (parsed.lpUrl !== undefined) data.lpUrl = parsed.lpUrl;

    // field_staff は campaign-level の型 options 変更で「担当外(再割当で隠れた)の未送付下書き」の本文まで
    // 無効化してしまう(型は campaign 横断で多数の宛先に共有)。GET/print/export/aggregate の scope 絞り込みと
    // 整合させるため、担当外の未送付下書きが1件でもあれば変更を拒否する(label のみ=何も変わらないは許可)。
    // ⚠判定は**トランザクションの中で、物件親行をロックしてから**行う(下記・@codex #376 R9)。
    const needsScopeCheck =
      (optionFieldChanged || designChanged || lpUrlChanged) && session.role === "field_staff";

    // 送付済みの宛先が使っている型は設定変更不可(送付後に設計/トーン/訴求やラベルを変えると CSV・送付履歴・
    // A/B 集計が実際に送った構成と食い違う)。sent チェック→型更新→下書き無効化を 1 トランザクションにまとめ、
    // 前後で sent を数えることで mark-sent との競合(TOCTOU=チェック後に別 request が sent 化)を検出し
    // ロールバックする(凍結=送った構成の不変性を守る)。
    const result = await prisma.$transaction(async (tx) => {
      // mark-sent との TOCTOU(label/設定変更が送付確定と競合し、送付後に型が変わって A/B 履歴・送付履歴が
      // 食い違う)を防ぐため、この型の宛先行を FOR UPDATE でロックして mark-sent と直列化する。sentBefore/
      // sentAfter のみでは mark-sent の未コミット更新を見落とす(label のみ編集は下書き行に触れずロックもしない)。
      // ロック後はどちらの順序でも整合(編集→送付=送付時点の型で送る / 送付→編集=sent検知で VARIANT_LOCKED)。
      // ロック順序（設計 §2.3）: variant → 物件親行 → draft。PR-D2 の「貼り付け／適用」は
      // 凍結判定のため variant を先に取るので、こちらも先に取らないと互いに待ち合って
      // デッドロックする。
      await tx.$queryRaw`SELECT id FROM dm_variants WHERE id = ${variantId}::uuid AND campaign_id = ${id}::uuid FOR UPDATE`;

      // ⚠担当範囲は**物件親行をロックしてから数え直す**(@codex #376 R9)。ロックの外で数えると、
      //   数えた直後〜commit の間に担当が変わった宛先の本文・印刷結果まで変えてしまう
      //   (貼り付け/適用/確定の各経路と同じ形にそろえる)。型行を掴んでいる間はこの型へ
      //   新しい宛先が入ってこない(割当は移動先の型を FOR UPDATE で掴む)ので、
      //   先読みした物件の集合はロックの下でも欠けない。
      if (needsScopeCheck) {
        const targets = await tx.dmRecipientDraft.findMany({
          where: { campaignId: id, variantId, status: { not: "sent" } },
          select: { propertyId: true },
        });
        const propertyIds = [...new Set(targets.map((t) => t.propertyId))].sort();
        if (propertyIds.length > 0) {
          await tx.$queryRaw`SELECT id FROM properties WHERE id = ANY(${propertyIds}::uuid[]) ORDER BY id FOR UPDATE`;
          const outOfScope = await tx.dmRecipientDraft.count({
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
      }

      await tx.$queryRaw`SELECT id FROM dm_recipient_drafts WHERE campaign_id = ${id}::uuid AND variant_id = ${variantId}::uuid FOR UPDATE`;
      // 凍結の二重判定（列 template_frozen_at OR 配下に confirmed/sent）。
      // 送付済みだけでなく**確定済み**でも設定を変えさせない＝文面と A/B 構成の出所を守る
      // （設計 §2.4）。列も見るので、割当で確定が型から離れた後でも凍結は失われない。
      const frozenRow = await tx.dmVariant.findFirst({
        where: { id: variantId, campaignId: id },
        select: { templateFrozenAt: true },
      });
      const sentBefore = await tx.dmRecipientDraft.count({
        where: { campaignId: id, variantId, status: { in: [...SETTLED_DRAFT_STATUSES] } },
      });
      if (
        isVariantFrozen({
          templateFrozenAt: frozenRow?.templateFrozenAt ?? null,
          settledCount: sentBefore,
        })
      ) {
        throw new ApiError(409, "送付実績のある型は設定を変更できません(A/B履歴の整合のため)", "VARIANT_LOCKED");
      }
      // campaignId で縛り、他キャンペーンの型を更新させない。
      const updated = await tx.dmVariant.update({ where: { id: variantId, campaignId: id }, data });
      // **プロンプトに載る設定**(tone/length/appeal/strength)を実際に変えたら、この型を使う未送付の
      // 下書きは旧いプロンプトで作った本文のため無効化(本文クリア→draft へ・貼り直しが要る)。
      // label のみ/空 options/デザイン/追加の指示は本文不変＝ここを通さない。
      if (optionFieldChanged) {
        // 古いプロンプトで作った本文を、新しい設定の型として再適用できてしまう不整合を
        // 防ぐため、原本とプロンプトの控えも同時に消す（設計 §2.4）。
        await tx.dmVariant.update({
          where: { id: variantId },
          data: { promptText: null, bodyTemplate: null },
        });
        await tx.dmRecipientDraft.updateMany({
          where: { campaignId: id, variantId, status: { not: "sent" }, body: { not: "" } },
          data: { body: "", status: "draft", confirmedAt: null },
        });
      } else if (lpUrlChanged) {
        // LP変更は本文を変えないが、確定済み(=印刷対象)の宛先の遷移先(/t/ がスキャン時に解決する先)を変える。
        // committed バッチが黙って別LPへ飛ぶのを防ぐため確定を解除し再承認を促す(本文は保持=再生成不要・Codex)。
        await tx.dmRecipientDraft.updateMany({
          where: { campaignId: id, variantId, status: "confirmed" },
          data: { status: "draft", confirmedAt: null },
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
    const { session } = await requireSaleDmWriteAccess();
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
    // 凍結済みの型は削除できない（設計 §2.4 @codex R14/R23）。既存判定は「宛先が居ない
    // こと」しか見ないため、割当で空にしてから削除すると**送付済み文面の出所ごと**消える。
    // 判定は PATCH と同じ二重判定を、variant 行のロックの下で行う。
    const deleted = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM dm_variants WHERE id = ${variantId}::uuid AND campaign_id = ${id}::uuid FOR UPDATE`;
      const row = await tx.dmVariant.findFirst({
        where: { id: variantId, campaignId: id },
        select: { templateFrozenAt: true },
      });
      const settledCount = await tx.dmRecipientDraft.count({
        where: { campaignId: id, variantId, status: { in: [...SETTLED_DRAFT_STATUSES] } },
      });
      if (
        isVariantFrozen({
          templateFrozenAt: row?.templateFrozenAt ?? null,
          settledCount,
        })
      ) {
        throw new ApiError(409, "送付実績のある型は削除できません", "VARIANT_FROZEN");
      }
      return tx.dmVariant.deleteMany({
        where: { id: variantId, campaignId: id, recipients: { none: {} } },
      });
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
