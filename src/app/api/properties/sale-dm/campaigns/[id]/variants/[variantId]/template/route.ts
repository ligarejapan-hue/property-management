import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import {
  requireSaleDmWriteAccess,
  assertSaleDmCampaignOwned,
} from "@/lib/sale-dm-letter/route-guard";
import {
  buildExternalPrompt,
  promptDigest,
} from "@/lib/sale-dm-letter/external-prompt";
import {
  SETTLED_DRAFT_STATUSES,
  isVariantFrozen,
} from "@/lib/sale-dm-letter/freeze";
import {
  letterBodyIssueMessage,
  validateLetterBody,
} from "@/lib/sale-dm-letter/body-validation";

const putSchema = z.object({
  body: z.string(),
  // 表示したプロンプトの指紋。表示〜貼り付けの間に型の設定が変わっていないかを見る。
  promptDigest: z.string().length(64),
});

/**
 * 型の本文（原本）の貼り付け保存（設計 §2.3）。
 *
 * 順序: variant 行を FOR UPDATE →（凍結・指紋・本文・担当範囲を確認）→ 保存 →
 * 未確定の下書きの本文をクリア。**同じ処理の中で**行うので、確認した状態のまま保存される。
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; variantId: string }> },
) {
  try {
    const { session } = await requireSaleDmWriteAccess();
    const { id, variantId } = await params;
    await assertSaleDmCampaignOwned(id, session.id);
    const parsed = putSchema.parse(await parseJsonBody(request));

    const result = await prisma.$transaction(async (tx) => {
      // ロック順序（設計 §2.3）: variant → 物件親行 → 子行。凍結判定と確定を直列化する。
      await tx.$queryRaw`SELECT id FROM dm_variants WHERE id = ${variantId}::uuid AND campaign_id = ${id}::uuid FOR UPDATE`;

      const variant = await tx.dmVariant.findFirst({
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
        throw new ApiError(
          404,
          "指定された型が見つかりません",
          "VARIANT_NOT_FOUND",
        );
      }

      // 凍結の二重判定（列 OR 配下の確定/送付済み）。ロックの下で数える。
      const settledCount = await tx.dmRecipientDraft.count({
        where: {
          campaignId: id,
          variantId,
          status: { in: [...SETTLED_DRAFT_STATUSES] },
        },
      });
      if (
        isVariantFrozen({
          templateFrozenAt: variant.templateFrozenAt,
          settledCount,
        })
      ) {
        // ⚠禁止すべきは「差し替え」であって「同じ本文の保存」ではない。中身が同じなら
        //   何も変わらないので通す（何も書かない）。違えば断る＝送付済み文面と新文面が
        //   同じ型に混ざり、A/B比較と出所が壊れるのを防ぐ（設計 §2.3 @codex R3/R15）。
        if (variant.bodyTemplate === parsed.body) {
          return { changed: false as const };
        }
        throw new ApiError(
          409,
          "送付実績のある型の文面は変更できません。文面を変えるときは新しい型を追加してください",
          "VARIANT_FROZEN",
        );
      }

      // 表示したときの設定と同じか。コピーしてから型の設定を変えていた場合を弾く。
      const prompt = buildExternalPrompt(variant);
      if (promptDigest(prompt) !== parsed.promptDigest) {
        throw new ApiError(
          409,
          "型の設定が変わっています。プロンプトを表示し直してから貼り付けてください",
          "PROMPT_STALE",
        );
      }

      // 本文の検査は貼り付け・一括適用・個別編集で同じ関数。ここは型の本文なので
      // 差込タグを許可する（適用時に物件ごとの値へ展開する）。
      const issue = validateLetterBody(parsed.body, { allowTags: true });
      if (issue) {
        throw new ApiError(400, letterBodyIssueMessage(issue), "INVALID_BODY");
      }

      // field_staff は、担当外（再割当で隠れた）の未確定下書きが1件でもあれば拒否。
      // 保存は下の一括クリアを伴うため、担当外の宛先の本文を消せてしまう穴を作らない
      // （既存の型設定 PATCH が採る規則と同じ）。
      if (session.role === "field_staff") {
        const outOfScope = await tx.dmRecipientDraft.count({
          where: {
            campaignId: id,
            variantId,
            status: { not: "sent" },
            property: {
              NOT: { OR: [{ createdBy: session.id }, { assignedTo: session.id }] },
            },
          },
        });
        if (outOfScope > 0) {
          throw new ApiError(
            403,
            "担当外の宛先を含む型は本文を保存できません",
            "FORBIDDEN",
          );
        }
      }

      // 原本と「その本文を作ったときのプロンプト」を同じ処理で保存する
      // （出所の記録が別のプロンプトを指す事故を防ぐ）。
      await tx.dmVariant.update({
        where: { id: variantId },
        data: { bodyTemplate: parsed.body, promptText: prompt },
      });

      // 差し替えの失効: 未確定の下書きの本文を全部クリアする。これをしないと、
      // 旧テンプレを適用済みの下書きが「空だけに適用」をすり抜け、
      // **記録は新・実際の手紙は旧**の食い違いが確定時に固定される（設計 §2.3 @codex R19）。
      const cleared = await tx.dmRecipientDraft.updateMany({
        where: {
          campaignId: id,
          variantId,
          status: { not: "sent" },
          body: { not: "" },
        },
        data: { body: "", status: "draft", confirmedAt: null },
      });

      return { changed: true as const, clearedCount: cleared.count };
    });

    if (result.changed) {
      await writeAuditLog({
        userId: session.id,
        action: "sale_dm_body_paste",
        targetTable: "dm_variants",
        targetId: variantId,
        // 非PII: 件数・ID・日時のみ（本文・プロンプトは残さない）。
        detail: {
          campaignId: id,
          clearedCount: result.clearedCount,
          pastedAt: new Date().toISOString(),
        },
      });
    }

    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
