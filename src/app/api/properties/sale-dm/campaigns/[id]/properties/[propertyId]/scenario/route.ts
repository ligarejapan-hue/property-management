/**
 * 「種類を変える」(物件単位・設計 2026-09-27-sale-dm-scenarios-design.md §3.3.0・§3.3.1・§3.4)。
 * 種類つきの発送で、その物件の宛先を全員まとめて別の種類の手紙+LPの組へ切り替え、
 * 同じトランザクションで物件の「DMの種類」欄(dm_scenario_id)も書く(版番号を1つ進め・変更履歴1行)。
 *
 * ロックの順(§3.3.1): 発送の行 → 今の型と移り先の型(id順)→ 物件 → 編集中の鍵の判定 → 宛先(id順)
 *   → 担当範囲の再確認 → 台帳(移り先の行・FOR SHARE)→(無ければ写して作る)。宛先を物件より先に取らない。
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { hasPermission } from "@/lib/permissions";
import { requireSaleDmWriteAccess, assertSaleDmCampaignOwned } from "@/lib/sale-dm-letter/route-guard";
import { markVariantsFrozen, markLpVariantsFrozen, SETTLED_DRAFT_STATUSES } from "@/lib/sale-dm-letter/freeze";
import { isScenarioCampaign, isValidScenarioPair, type PairVariant } from "@/lib/sale-dm-letter/scenario-campaign";
import {
  checkScenarioReady,
  copyScenarioIntoCampaign,
  attachScenario,
  loadScenariosForCopy,
} from "@/lib/sale-dm-letter/scenario-copy";
import { lockScenarioForShare } from "@/lib/sale-dm-letter/scenario-guard";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { assertNotEditLockedByOther } from "@/lib/edit-lock/service";
import { readScreenTokenHash, readLockId } from "@/lib/edit-lock/screen-token";
import { canAccessPropertyRecord, isPropertyScopedRole } from "@/lib/property-access";
import { saleDmScenarioChangeSchema } from "@/lib/validators-sale-dm";

const paramsSchema = z.object({
  id: z.string().uuid().transform((s) => s.toLowerCase()),
  propertyId: z.string().uuid().transform((s) => s.toLowerCase()),
});

const UNAVAILABLE_MESSAGE = "選んだDMの種類は使えなくなりました。選び直してください";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; propertyId: string }> },
) {
  try {
    const { session, permissions } = await requireSaleDmWriteAccess();
    // 物件の欄も書くので、物件を編集できる権限が要る(§3.4)。requireSaleDmWriteAccess も同じ門を持つが、
    // この操作の要件として明示しておく(門の定義が将来変わっても外れないように)。
    if (!hasPermission(permissions, "property", "write")) {
      throw new ApiError(403, "物件情報の編集権限がありません", "FORBIDDEN");
    }
    const parsedParams = paramsSchema.safeParse(await params);
    if (!parsedParams.success) throw new ApiError(404, "キャンペーンが見つかりません", "NOT_FOUND");
    const { id, propertyId } = parsedParams.data;
    await assertSaleDmCampaignOwned(id, session.id); // 他人の発送は 404(存在を漏らさない)。
    const { scenarioId } = saleDmScenarioChangeSchema.parse(await parseJsonBody(request));
    // 編集の鍵(X-Edit-Lock)の形式チェックは readLockId 側で行う(不正なら 400)。
    const screenTokenHash = readScreenTokenHash(request);
    const lockId = readLockId(request);

    const result = await prisma.$transaction(async (tx) => {
      // ① 発送の行。同時に2件来ても「写しが有るか確認→無ければ作る」が直列になる(§3.4)。
      const campaigns = await tx.$queryRaw<Array<{ id: string; default_scenario_id: string | null; created_by: string }>>`
        SELECT id, default_scenario_id, created_by FROM dm_campaigns WHERE id = ${id}::uuid FOR UPDATE`;
      const row = campaigns[0];
      if (!row || row.created_by !== session.id) {
        throw new ApiError(404, "キャンペーンが見つかりません", "NOT_FOUND");
      }
      const campaign = { defaultScenarioId: row.default_scenario_id };
      if (!isScenarioCampaign(campaign)) {
        throw new ApiError(409, "この発送はDMの種類を使っていません", "SCENARIO_CAMPAIGN_REQUIRED");
      }

      // ② 今の型と移り先の型(既にあれば)を id 順に押さえる。ロック前の先読みで集合を決め、
      //    宛先をロックした後に収まっているかを確かめる(assign と同じ形)。
      const pre = await tx.dmRecipientDraft.findMany({
        where: { campaignId: id, propertyId },
        select: { variantId: true, lpVariantId: true },
      });
      if (pre.length === 0) {
        throw new ApiError(404, "この発送にこの物件の宛先がありません", "NO_RECIPIENTS");
      }
      const preVariantIds = [...new Set(pre.map((d) => d.variantId))];
      const preLpIds = [...new Set(pre.map((d) => d.lpVariantId).filter((x): x is string => !!x))];
      const letters = await tx.dmVariant.findMany({
        where: { campaignId: id, OR: [{ id: { in: preVariantIds } }, { scenarioId }] },
        select: { id: true, scenarioId: true },
      });
      const lps = await tx.dmLpVariant.findMany({
        where: { campaignId: id, OR: [{ id: { in: preLpIds } }, { scenarioId }] },
        select: { id: true, scenarioId: true },
      });
      const lockVariantIds = [...new Set([...preVariantIds, ...letters.map((l) => l.id)])].sort();
      const lockLpIds = [...new Set([...preLpIds, ...lps.map((l) => l.id)])].sort();
      if (lockVariantIds.length > 0) {
        await tx.$queryRaw`SELECT id FROM dm_variants WHERE id = ANY(${lockVariantIds}::uuid[]) AND campaign_id = ${id}::uuid ORDER BY id FOR UPDATE`;
      }
      if (lockLpIds.length > 0) {
        await tx.$queryRaw`SELECT id FROM dm_lp_variants WHERE id = ANY(${lockLpIds}::uuid[]) AND campaign_id = ${id}::uuid ORDER BY id FOR UPDATE`;
      }

      // ③ 物件。種類の判定・差し込み・担当範囲に使う値はロック後に読み直したものだけを使う。
      await lockPropertyRow(tx, propertyId);
      const property = await tx.property.findUnique({
        where: { id: propertyId },
        select: { id: true, version: true, dmScenarioId: true, address: true, propertyType: true, createdBy: true, assignedTo: true },
      });
      if (!property) throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");

      // ④ 編集中の鍵(PATCH /api/properties/[id] と同じ判定)。他の人が有効な鍵を持っていれば 423。
      await assertNotEditLockedByOther(tx, {
        resourceType: "property",
        resourceId: propertyId,
        userId: session.id,
        screenTokenHash,
        lockId,
      });

      // ⑤ 宛先(id順)。ロックの下で読み直す。
      await tx.$queryRaw`SELECT id FROM dm_recipient_drafts WHERE campaign_id = ${id}::uuid AND property_id = ${propertyId}::uuid ORDER BY id FOR UPDATE`;
      const drafts = await tx.dmRecipientDraft.findMany({
        where: { campaignId: id, propertyId },
        select: { id: true, variantId: true, lpVariantId: true, status: true },
        orderBy: { id: "asc" },
      });
      if (drafts.length === 0) {
        throw new ApiError(404, "この発送にこの物件の宛先がありません", "NO_RECIPIENTS");
      }
      // 一部だけ変えると同じ物件で種類が割れるので、1人でも送付済みなら断る。
      if (drafts.some((d) => d.status === "sent")) {
        throw new ApiError(409, "送付済みの宛先があるため、この物件の種類は変えられません", "SCENARIO_CHANGE_SENT");
      }
      const lockedVariants = new Set(lockVariantIds);
      const lockedLps = new Set(lockLpIds);
      for (const d of drafts) {
        if (!lockedVariants.has(d.variantId) || (d.lpVariantId !== null && !lockedLps.has(d.lpVariantId))) {
          throw new ApiError(409, "途中で宛先の型が変わりました。画面を更新してからやり直してください", "VARIANT_CHANGED");
        }
      }

      // ⑥ 担当範囲の再確認(ロック前の確認の後に担当が付け替えられた場合に書かない)。
      if (isPropertyScopedRole(session.role) && !canAccessPropertyRecord(session, property)) {
        throw new ApiError(403, "この物件を操作する権限がありません", "FORBIDDEN");
      }

      // 同じ種類への変更=宛先も物件の欄も既にその種類なら何もしない(監査も書かない)。
      const letterScenarioById = new Map(letters.map((l) => [l.id, l.scenarioId]));
      const existingTargetLpId = lps.find((l) => l.scenarioId === scenarioId)?.id ?? null;
      const draftsSame = drafts.every(
        (d) => letterScenarioById.get(d.variantId) === scenarioId && d.lpVariantId === existingTargetLpId,
      );
      const propertySame = property.dmScenarioId === scenarioId;
      if (draftsSame && propertySame) {
        return { wrote: false, changedDrafts: 0, blankBodyCount: 0, lpMissing: existingTargetLpId === null };
      }

      // ⑦ 台帳(移り先の行・FOR SHARE)。ロック後に「有る・使う」を読み直す。
      const locked = await lockScenarioForShare(tx, scenarioId);
      if (!locked || !locked.active || locked.deletedAt) {
        throw new ApiError(409, UNAVAILABLE_MESSAGE, "SCENARIO_UNAVAILABLE");
      }
      const scenario = (await loadScenariosForCopy(tx)).find((s) => s.id === scenarioId);
      if (!scenario) throw new ApiError(409, UNAVAILABLE_MESSAGE, "SCENARIO_UNAVAILABLE");
      // 準備の検査(§3.3.0-1)。止まる種類なら宛先には何もせず 409。
      const ready = checkScenarioReady(scenario);
      if (!ready.ok) {
        if (ready.reason === "unusable") throw new ApiError(409, UNAVAILABLE_MESSAGE, "SCENARIO_UNAVAILABLE");
        throw new ApiError(409, `手紙の文面がまだ登録されていないDMの種類です: ${scenario.name}`, "SCENARIO_NOT_READY");
      }

      let changedDrafts = 0;
      let blankBodyCount = 0;
      let lpMissing = existingTargetLpId === null;
      if (!draftsSame) {
        // ⑧ 下書きに戻す前に、移動元の型へ凍結の印(確定済みの宛先がいるときのみ・型は②で押さえ済み)。
        //    最後の確定済みが抜けると「確定済みの宛先がある」という凍結の根拠が消えるため(§3.4)。
        const settledStatuses = new Set<string>(SETTLED_DRAFT_STATUSES);
        const settled = drafts.filter((d) => settledStatuses.has(d.status));
        if (settled.length > 0) {
          await markVariantsFrozen(tx, settled.map((d) => d.variantId));
          await markLpVariantsFrozen(tx, settled.map((d) => d.lpVariantId));
        }
        // ⑨ 写す(既に写しがあればそれを使う=発送の行を押さえているので同時でも1つ)。
        const copy = await copyScenarioIntoCampaign(tx, id, scenario);
        // ⑩ 付けて差し込む(共通手順)。本文は写しの本文(既に写しがあれば台帳の今の本文ではなくその写しの本文)。
        //    差し込めない物件は本文を空のまま下書きにし、件数を返す。
        const attached = attachScenario(copy, property);
        const lpVariants: PairVariant[] = [
          ...lps,
          ...(copy.lpVariantId !== null && !lps.some((l) => l.id === copy.lpVariantId)
            ? [{ id: copy.lpVariantId, scenarioId: scenario.id }]
            : []),
        ];
        // 組の決まり(§3.3.0)。写した組をそのまま付けるので必ず成り立つ=外れたらバグ(500・何も書かない)。
        if (!isValidScenarioPair(campaign, { id: attached.variantId, scenarioId: scenario.id }, attached.lpVariantId, lpVariants)) {
          throw new Error("invariant: 種類の手紙とLPの組が決まりに合わない");
        }
        const updated = await tx.dmRecipientDraft.updateMany({
          where: { id: { in: drafts.map((d) => d.id) }, campaignId: id, propertyId, status: { not: "sent" } },
          data: {
            variantId: attached.variantId,
            lpVariantId: attached.lpVariantId,
            body: attached.body,
            status: "draft",
            confirmedAt: null,
          },
        });
        changedDrafts = updated.count;
        blankBodyCount = attached.blank ? updated.count : 0;
        lpMissing = copy.lpVariantId === null;
      }

      // ⑪ 物件の欄(方針0-2=直す場所は物件)。版番号を1つ進め、開いたままの古い物件画面の保存を 409 にする。
      if (!propertySame) {
        const written = await tx.property.updateMany({
          where: { id: propertyId, version: property.version },
          data: { dmScenarioId: scenarioId, version: { increment: 1 } },
        });
        if (written.count === 0) {
          throw new ApiError(409, "物件が他の操作で更新されました。画面を更新してからやり直してください", "VERSION_CONFLICT");
        }
        await tx.changeLog.create({
          data: {
            targetTable: "properties",
            targetId: propertyId,
            fieldName: "dmScenarioId",
            oldValue: property.dmScenarioId,
            newValue: scenarioId,
            source: "manual",
            changedBy: session.id,
          },
        });
      }

      return { wrote: true, changedDrafts, blankBodyCount, lpMissing };
    });

    if (result.wrote) {
      // 操作名・id・件数だけ(文面の中身・種類の名前は載せない)。
      await writeAuditLog({
        userId: session.id,
        action: "sale_dm_scenario_change",
        targetTable: "properties",
        targetId: propertyId,
        detail: { campaignId: id, propertyId, changedDrafts: result.changedDrafts, blankBodyCount: result.blankBodyCount },
      });
    }

    return NextResponse.json(
      { changedDrafts: result.changedDrafts, blankBodyCount: result.blankBodyCount, lpMissing: result.lpMissing },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
