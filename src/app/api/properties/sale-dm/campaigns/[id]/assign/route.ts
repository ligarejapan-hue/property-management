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
      // 送付済み(sent)は A/B バケットを再割当しない(送付済みの配達/反響結果が別型へ移るのを防ぐ)。
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
        select: { variantId: true, lpVariantId: true, propertyId: true },
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

      // ⚠**ロックの下で移動元をもう一度読み、掴んだ型の集合に収まっているか確かめる**（@codex R4 P2）。
      //   上の lockVariantIds / lockLpIds は**ロック前**の sourcesPre で決めた集合。読んでから
      //   ロックが取れるまでの間に別の割当がこの下書きを**別の型へ移す**と、移動元がロック集合の
      //   外に出る。そのまま進むと markVariantsFrozen / markLpVariantsFrozen が**ロックしていない行**を
      //   物件ロックの後に書き換え、取得順が dm_lp_variants → properties の逆になる
      //   （LP文面の保存 PUT は dm_lp_variants を掴んでから properties を待つ＝互い違いに止まる）。
      //   追いかけて掴み直すと順序がさらに崩れるので、**やり直してもらう**（409）。
      const targetsPost = await tx.dmRecipientDraft.findMany({
        where: { id: { in: allIds }, campaignId: id },
        select: { variantId: true, lpVariantId: true, status: true },
      });
      const lockedVariantIds = new Set(lockVariantIds);
      const lockedLpIds = new Set(lockLpIds);
      for (const d of targetsPost) {
        if (!lockedVariantIds.has(d.variantId) || (d.lpVariantId != null && !lockedLpIds.has(d.lpVariantId))) {
          throw new ApiError(409, "割当の途中で別の割当が動きました。画面を更新してからやり直してください", "VARIANT_CHANGED");
        }
      }

      // ⚠**物件親行をロックしてから担当範囲を確かめ直す**（@codex R2 P1）。:32 の scope 絞り込みは
      //   トランザクションの**外**の先読みなので、読んだ直後〜commit の間に物件が別担当へ再割当
      //   されると、担当外になった宛先の DM型/LP型まで書き換えてしまう（本文もクリアされる）。
      //   ロック順序（設計 §2.3/§2.8）: dm_variants → dm_lp_variants → properties → dm_recipient_drafts。
      // ⚠ロック自体は**全ロールで**取る。admin/office が取らないと、確定(drafts/confirm)や反響の
      //   書き手と取得順がそろわず互い違いに待つ（確定は物件親行を全ロールで掴む）。
      const targetPropertyIds = [...new Set(sourcesPre.map((d) => d.propertyId))].sort();
      if (targetPropertyIds.length > 0) {
        await tx.$queryRaw`SELECT id FROM properties WHERE id = ANY(${targetPropertyIds}::uuid[]) ORDER BY id FOR UPDATE`;
        // where のリレーション述語はステートメントのスナップショットで評価されるため、
        // ロックの下で**物件そのもの**を読み直す（確定 route と同じ形・可視条件は
        // createdBy==me OR assignedTo==me）。1件でも見えなくなっていたらやり直してもらう。
        if (session.role === "field_staff") {
          const visible = await tx.property.findMany({
            where: {
              id: { in: targetPropertyIds },
              OR: [{ createdBy: session.id }, { assignedTo: session.id }],
            },
            select: { id: true },
          });
          if (visible.length !== targetPropertyIds.length) {
            throw new ApiError(
              403,
              "担当が変わった宛先が含まれています。画面を更新してからやり直してください",
              "FORBIDDEN",
            );
          }
        }
      }

      // ⚠確定済み/送付済みの下書きを別の型へ移すと、移動元の型から「確定があった」
      //   証拠が消える。移す前に**移動元**の型へ凍結印を立てる（設計 §2.4 @codex R24/R31）。
      //   ロックを保持したまま読み直した targetsPost から絞る（先読み〜ロックの間の移動を
      //   取りこぼさない・上でロック集合に収まっていることを確かめ済み）。
      const settled = new Set<string>(SETTLED_DRAFT_STATUSES);
      const movingSettled = targetsPost.filter((d) => settled.has(d.status));
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
        // ⚠`lpVariantId` は NULL 許容列。Prisma の `not` は NULL 行にマッチしないため、
        //   `NOT: { lpVariantId }` だと未割当(NULL)の下書きが更新対象から漏れる
        //   (下書きは全て lpVariantId=NULL で始まる)。NULL 行を明示的に含める。
        const result = await tx.dmRecipientDraft.updateMany({
          where: { id: { in: ids }, campaignId: id, status: { not: "sent" }, OR: [{ lpVariantId: null }, { lpVariantId: { not: lpVariantId } }] },
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
