import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import {
  requireSaleDmAccess,
  assertSaleDmCampaignOwned,
} from "@/lib/sale-dm-letter/route-guard";
import {
  buildExternalPrompt,
  promptDigest,
  bodyTemplateDigest,
} from "@/lib/sale-dm-letter/external-prompt";
import {
  SETTLED_DRAFT_STATUSES,
  isVariantFrozen,
} from "@/lib/sale-dm-letter/freeze";

/**
 * 外部AIへ貼るプロンプトの表示（設計 §2.2）。
 *
 * ⚠**読み取り**なので `property:write` は要求しない（表示するだけ）。
 * プロンプトは型の設定だけから作られ、宛先・物件・差出人は構造上載らない
 * （buildExternalPrompt の引数にそもそも無い）。
 *
 * digest は「表示した時の設定」の指紋。貼り付け保存はこれと一致することを要求し、
 * コピーしてから設定が変わっていた場合に版ずれを検出する（§2.3）。
 * bodyDigest は「表示した時の原本」の指紋。保存はこれも一致することを要求し、
 * 別の画面が先に保存した文面を黙って差し替えるのを防ぐ（@codex #376 R14）。
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; variantId: string }> },
) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id, variantId } = await params;
    // 作成者本人のキャンペーンの型のみ。見つからない/他人のものは同じ 404（存在秘匿）。
    await assertSaleDmCampaignOwned(id, session.id);

    const variant = await prisma.dmVariant.findFirst({
      where: { id: variantId, campaignId: id },
      select: {
        id: true,
        tone: true,
        length: true,
        appeal: true,
        strength: true,
        templateFrozenAt: true,
        bodyTemplate: true,
      },
    });
    if (!variant) {
      throw new ApiError(404, "指定された型が見つかりません", "VARIANT_NOT_FOUND");
    }

    // 凍結は二重判定（列 OR 配下の確定/送付済み）。表示は読み取りなのでロックは取らない
    // ＝画面の出し分け用の目安。実際の禁止判定は貼り付け・削除の tx がロック下で行う。
    const settledCount = await prisma.dmRecipientDraft.count({
      where: {
        campaignId: id,
        variantId,
        status: { in: [...SETTLED_DRAFT_STATUSES] },
      },
    });

    const prompt = buildExternalPrompt(variant);

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_prompt_view",
      targetTable: "dm_variants",
      targetId: variantId,
      // 非PII: 件数・ID・日時のみ（プロンプト本文・手紙本文は残さない）。
      detail: { campaignId: id, viewedAt: new Date().toISOString() },
    });

    return NextResponse.json(
      {
        prompt,
        digest: promptDigest(prompt),
        frozen: isVariantFrozen({
          templateFrozenAt: variant.templateFrozenAt,
          settledCount,
        }),
        bodyTemplate: variant.bodyTemplate,
        // 保存時に「開いたときの原本と同じか」を照合するための指紋（@codex #376 R14）。
        // ⚠digest（設定の指紋）は2つのタブで同じ値になるため、これが無いと先に保存された
        //   文面を古い画面が黙って差し替えられる。
        bodyDigest: bodyTemplateDigest(variant.bodyTemplate),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
