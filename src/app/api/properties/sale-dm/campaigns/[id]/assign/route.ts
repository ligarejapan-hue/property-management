import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmWriteAccess, assertSaleDmCampaignOwned, filterDraftsByFieldStaffScope } from "@/lib/sale-dm-letter/route-guard";
import { markVariantsFrozen, markLpVariantsFrozen, SETTLED_DRAFT_STATUSES } from "@/lib/sale-dm-letter/freeze";
import { saleDmAssignSchema } from "@/lib/validators-sale-dm";
import { assignCrossEvenly, applyManualAssignment } from "@/lib/sale-dm-letter/assign";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { session } = await requireSaleDmWriteAccess();
    const { id } = await params;
    await assertSaleDmCampaignOwned(id, session.id); // 作成者本人のキャンペーンのみ割当可。
    const body = saleDmAssignSchema.parse(await parseJsonBody(request));

    const [variants, lpVariants, recipients] = await Promise.all([
      prisma.dmVariant.findMany({ where: { campaignId: id }, select: { id: true }, orderBy: { label: "asc" } }),
      prisma.dmLpVariant.findMany({ where: { campaignId: id }, select: { id: true }, orderBy: { label: "asc" } }),
      prisma.dmRecipientDraft.findMany({ where: { campaignId: id, status: { not: "sent" } }, select: { id: true, property: { select: { createdBy: true, assignedTo: true } } }, orderBy: { id: "asc" } }),
    ]);

    if (variants.length === 0) {
      throw new ApiError(409, "割り当てる型がありません(先に型を作成してください)", "NO_VARIANTS");
    }

    const variantIds = variants.map((v) => v.id);
    const lpVariantIds = lpVariants.map((v) => v.id);
    // field_staff は現在の物件 record scope の宛先のみ割当対象にする(担当外物件の本文を
    // 勝手にクリア/再割当しない・GET campaign / print / export と統一)。
    const recipientIds = filterDraftsByFieldStaffScope(recipients, session).map((r) => r.id);

    // DM軸の割当(既存の形)。LP軸は別 Map に分ける(LP は本文に影響しないので本文を消さない)。
    const dmAssignment = new Map<string, string>();
    const lpAssignment = new Map<string, string>();
    if (body.mode === "manual") {
      for (const [rid, vid] of applyManualAssignment(recipientIds, variantIds, body.assignments ?? [])) dmAssignment.set(rid, vid);
      const lpManual = (body.lpAssignments ?? []).map((a) => ({ recipientId: a.recipientId, variantId: a.lpVariantId }));
      for (const [rid, lid] of applyManualAssignment(recipientIds, lpVariantIds, lpManual)) lpAssignment.set(rid, lid);
    } else {
      for (const [rid, a] of assignCrossEvenly(recipientIds, variantIds, lpVariantIds, { order: body.order ?? "sequential" })) {
        dmAssignment.set(rid, a.variantId);
        if (a.lpVariantId) lpAssignment.set(rid, a.lpVariantId);
      }
    }

    const byVariant = new Map<string, string[]>();
    for (const [recipientId, variantId] of dmAssignment) {
      const bucket = byVariant.get(variantId);
      if (bucket) bucket.push(recipientId);
      else byVariant.set(variantId, [recipientId]);
    }
    const byLpVariant = new Map<string, string[]>();
    for (const [recipientId, lpVariantId] of lpAssignment) {
      const bucket = byLpVariant.get(lpVariantId);
      if (bucket) bucket.push(recipientId);
      else byLpVariant.set(lpVariantId, [recipientId]);
    }

    let assigned = 0;
    let assignedLp = 0;
    const perVariant: Record<string, number> = {};
    const perLpVariant: Record<string, number> = {};
    // 型ごとの updateMany を1トランザクションにまとめる。途中失敗(例: 対象 variant が並行削除されFK違反)で
    // 一部の宛先だけ本文がクリアされる部分破壊(=一部だけ要再生成の半端な状態)を防ぐ(all-or-nothing)。
    await prisma.$transaction(async (tx) => {
      // ⚠ロック順序（設計 §2.3: Owner → variant → 物件親行 → 子行）。
      //   下の updateMany は draft の variantId を書き換えるため、PostgreSQL が参照先の
      //   型行に KEY SHARE ロックを**後から**取る。確定(drafts/confirm)は型を先に掴むので、
      //   ここで先に取らないとデッドロックになる。
      // ⚠**移動元の型もロック対象に含める**（@codex #376 R4）。確定済みを移すときは移動元へ
      //   凍結印を立てるので、移動先だけ掴んで移動元を後から触ると、確定側が A→B の順で
      //   掴んでいる場合と互い違いになって止まる。**両方をまとめて id 順に**取る。
      // ⚠移動元の収集に**状態(確定済みか)の条件を付けない**（@codex #376 R9）。付けると、
      //   先読みのあとに確定された下書きの移動元がロック集合から漏れる。凍結印を立てる
      //   markVariantsFrozen は「その型をロック済みであること」が前提なので、漏れた型へ
      //   印を立てると取得順の保証が崩れる（型の取り方が違う処理どうしが互い違いに待つ）。
      //   移動する下書きの移動元は、状態に関わらず**全部**掴む（型はキャンペーン内で数個）。
      const allIds = [...new Set([...[...byVariant.values()].flat(), ...[...byLpVariant.values()].flat()])];
      const sourcesPre = await tx.dmRecipientDraft.findMany({
        where: { id: { in: allIds }, campaignId: id },
        select: { variantId: true, lpVariantId: true },
      });
      const lockVariantIds = [...new Set([...byVariant.keys(), ...sourcesPre.map((d) => d.variantId)])].sort();
      if (lockVariantIds.length > 0) {
        await tx.$queryRaw`SELECT id FROM dm_variants WHERE id = ANY(${lockVariantIds}::uuid[]) AND campaign_id = ${id}::uuid ORDER BY id FOR UPDATE`;
      }
      // ロック順序(設計 2026-09-08): dm_variants → dm_lp_variants。移動元・移動先の両方を id 順に。
      const lockLpIds = [...new Set([...byLpVariant.keys(), ...sourcesPre.map((d) => d.lpVariantId).filter((x): x is string => !!x)])].sort();
      if (lockLpIds.length > 0) {
        await tx.$queryRaw`SELECT id FROM dm_lp_variants WHERE id = ANY(${lockLpIds}::uuid[]) AND campaign_id = ${id}::uuid ORDER BY id FOR UPDATE`;
      }

      // ⚠確定済み/送付済みの下書きを別の型へ移すと、移動元の型から「確定があった」
      //   証拠が消える。移す前に**移動元**の型へ凍結印を立てる（設計 §2.4 @codex R24/R31）。
      //   ロックを保持したまま読み直す（先読み〜ロックの間の移動を取りこぼさない）。
      const movingSettled = await tx.dmRecipientDraft.findMany({
        where: {
          id: { in: allIds },
          campaignId: id,
          status: { in: [...SETTLED_DRAFT_STATUSES] },
        },
        select: { variantId: true, lpVariantId: true },
      });
      await markVariantsFrozen(tx, movingSettled.map((d) => d.variantId));
      await markLpVariantsFrozen(tx, movingSettled.map((d) => d.lpVariantId));
      for (const [variantId, ids] of byVariant) {
        if (ids.length === 0) continue;
        const result = await tx.dmRecipientDraft.updateMany({
          // 型が実際に変わる宛先のみ更新し、本文をクリア(=要再生成)。型と本文の作風が不一致の
          // まま確定/印刷/送付されるのを防ぐ(空 body は confirm/print から除外済み)。再生成すると
          // 現在の型の作風で本文が入り確定可能になる。既に同じ型の宛先は触らない(本文を保全)。
          where: { id: { in: ids }, campaignId: id, status: { not: "sent" }, variantId: { not: variantId } },
          // 本文クリア時は status も draft に戻し confirmedAt を消す(confirmed のまま空 body だと
          // mark-sent が空 letter を送付済みにし得るため)。再生成→再確定の lifecycle を強制。
          data: { variantId, body: "", status: "draft", confirmedAt: null },
        });
        assigned += result.count;
        perVariant[variantId] = result.count;
      }
      for (const [lpVariantId, ids] of byLpVariant) {
        if (ids.length === 0) continue;
        // LP型は本文に影響しない(表示のたびに展開)ので、本文・状態は触らない。
        const result = await tx.dmRecipientDraft.updateMany({
          where: { id: { in: ids }, campaignId: id, status: { not: "sent" }, NOT: { lpVariantId } },
          data: { lpVariantId },
        });
        assignedLp += result.count;
        perLpVariant[lpVariantId] = result.count;
      }
    });

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_assign_variants",
      targetTable: "dm_recipient_drafts",
      detail: { campaignId: id, mode: body.mode, order: body.order ?? null, assigned, assignedLp, perVariant, assignedAt: new Date().toISOString() },
    });

    return NextResponse.json({ assigned, perVariant, assignedLp, perLpVariant }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
