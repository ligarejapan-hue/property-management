import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmWriteAccess, assertSaleDmCampaignOwned, filterDraftsByFieldStaffScope } from "@/lib/sale-dm-letter/route-guard";
import { saleDmAssignSchema } from "@/lib/validators-sale-dm";
import { assignVariantsEvenly, applyManualAssignment } from "@/lib/sale-dm-letter/assign";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { session } = await requireSaleDmWriteAccess();
    const { id } = await params;
    await assertSaleDmCampaignOwned(id, session.id); // 作成者本人のキャンペーンのみ割当可。
    const body = saleDmAssignSchema.parse(await parseJsonBody(request));

    const [variants, recipients] = await Promise.all([
      prisma.dmVariant.findMany({ where: { campaignId: id }, select: { id: true }, orderBy: { label: "asc" } }),
      // 送付済み(sent)は A/B バケットを再割当しない(送付済みの配達/反響結果が別型へ移るのを防ぐ)。
      prisma.dmRecipientDraft.findMany({ where: { campaignId: id, status: { not: "sent" } }, select: { id: true, property: { select: { createdBy: true, assignedTo: true } } }, orderBy: { id: "asc" } }),
    ]);

    if (variants.length === 0) {
      throw new ApiError(409, "割り当てる型がありません(先に型を作成してください)", "NO_VARIANTS");
    }

    const variantIds = variants.map((v) => v.id);
    // field_staff は現在の物件 record scope の宛先のみ割当対象にする(担当外物件の本文を
    // 勝手にクリア/再割当しない・GET campaign / print / export と統一)。
    const recipientIds = filterDraftsByFieldStaffScope(recipients, session).map((r) => r.id);

    const assignment =
      body.mode === "manual"
        ? applyManualAssignment(recipientIds, variantIds, body.assignments ?? [])
        : assignVariantsEvenly(recipientIds, variantIds, { order: body.order ?? "sequential" });

    // variantId ごとに recipient id をまとめ、型ごとに 1 回の updateMany で反映(N+1 回避)。
    const byVariant = new Map<string, string[]>();
    for (const [recipientId, variantId] of assignment) {
      const bucket = byVariant.get(variantId);
      if (bucket) bucket.push(recipientId);
      else byVariant.set(variantId, [recipientId]);
    }

    let assigned = 0;
    const perVariant: Record<string, number> = {};
    // 型ごとの updateMany を1トランザクションにまとめる。途中失敗(例: 対象 variant が並行削除されFK違反)で
    // 一部の宛先だけ本文がクリアされる部分破壊(=一部だけ要再生成の半端な状態)を防ぐ(all-or-nothing)。
    await prisma.$transaction(async (tx) => {
      // ⚠ロック順序（設計 §2.3: Owner → variant → 物件親行 → 子行）。
      //   下の updateMany は draft の variantId を書き換えるため、PostgreSQL が参照先の
      //   型行に KEY SHARE ロックを**後から**取る。確定(drafts/confirm)は型を先に掴むので、
      //   ここで先に取らないと「割当が draft を持って型を待ち、確定が型を持って draft を待つ」
      //   デッドロックになる(@codex #375)。id 順に揃えて取り、経路間で順序を一致させる。
      const lockVariantIds = [...byVariant.keys()].sort();
      if (lockVariantIds.length > 0) {
        await tx.$queryRaw`SELECT id FROM dm_variants WHERE id = ANY(${lockVariantIds}::uuid[]) AND campaign_id = ${id}::uuid ORDER BY id FOR UPDATE`;
      }
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
    });

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_assign_variants",
      targetTable: "dm_recipient_drafts",
      detail: { campaignId: id, mode: body.mode, order: body.order ?? null, assigned, perVariant, assignedAt: new Date().toISOString() },
    });

    return NextResponse.json({ assigned, perVariant }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
