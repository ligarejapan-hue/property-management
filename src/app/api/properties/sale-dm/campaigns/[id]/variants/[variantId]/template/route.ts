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
  bodyTemplateDigest,
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
  // 画面を開いたときに見えていた**原本**の指紋。⚠プロンプトの指紋は設定だけから作られる
  // ので2つのタブで同じ値になる（@codex #376 R14）。原本の指紋も一緒に見ないと、
  // 先に保存・適用された文面を古い画面からの保存が黙って差し替えてしまう。
  baseBodyDigest: z.string().length(64),
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

      // ⚠**中身が同じ保存は、凍結の有無に関わらず何も書かない**(@codex #376 R2 P1)。
      //   差し替えでない保存で未確定の下書きを全消しすると、適用済み・手直し済みの本文が
      //   まとめて失われる。
      if (variant.bodyTemplate === parsed.body) {
        // 指紋も返す。⚠画面が保存後に取り直すと、その一瞬に別の画面が保存していた場合
        //   **相手の指紋**を自分の古い入力欄と組み合わせて持ってしまい、次の保存で
        //   版ずれ検出をすり抜ける（@codex #376 R15）。**書いた値から作ってここで返す**。
        return { changed: false as const, bodyDigest: bodyTemplateDigest(parsed.body) };
      }

      // 凍結の二重判定（列 OR 配下の確定/送付済み）。ロックの下で数える。
      const settledCount = await tx.dmRecipientDraft.count({
        where: {
          campaignId: id,
          variantId,
          status: { in: [...SETTLED_DRAFT_STATUSES] },
        },
      });
      const frozen = isVariantFrozen({
        templateFrozenAt: variant.templateFrozenAt,
        settledCount,
      });
      // ⚠**まだ原本が無い型への保存は「初期化」として凍結中でも許可**する(@codex #376 R2 P2)。
      //   PR-D2 以前からある型は、確定/送付済みの宛先を持つ＝凍結だが原本は空。ここを断ると、
      //   割当でその型へ移された宛先（本文は空になる）に何も入れられず詰む。
      //   禁止すべきは「差し替え」であって「最初の1回」ではない。
      const isInitialization =
        !variant.bodyTemplate || variant.bodyTemplate.trim().length === 0;
      if (frozen && !isInitialization) {
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
      // 画面を開いたときに見えていた原本と、いまの原本が同じか（@codex #376 R14）。
      // ⚠設定の指紋は2つのタブで同じ値になるので、これを見ないと**先に保存・適用された
      //   文面**を古い画面からの保存が黙って差し替え、適用済みの下書きまで消える。
      //   理由が違えば文言も分ける（設定が変わった／別の人が先に保存した）。
      if (bodyTemplateDigest(variant.bodyTemplate) !== parsed.baseBodyDigest) {
        throw new ApiError(
          409,
          "この型の文面は、ほかの画面で先に保存されています。開き直して最新の文面を確認してから貼り付けてください",
          "TEMPLATE_STALE",
        );
      }

      // 本文の検査は貼り付け・一括適用・個別編集で同じ関数。ここは型の本文なので
      // 差込タグを許可する（適用時に物件ごとの値へ展開する）。
      const issue = validateLetterBody(parsed.body, { allowTags: true });
      if (issue) {
        throw new ApiError(400, letterBodyIssueMessage(issue), "INVALID_BODY");
      }

      // field_staff は、担当外（再割当で隠れた）の未確定下書きが1件でもあれば拒否。
      // 保存は下の一括クリアを伴うため、担当外の宛先の本文を消せてしまう穴を作らない。
      // ⚠**物件親行をロックしてから読み直す**(@codex #376 R2 P1)。ロックなしで数えると、
      //   数えた後〜クリアの間に担当が変わった宛先を書き換えてしまう。
      if (session.role === "field_staff") {
        const unsent = await tx.dmRecipientDraft.findMany({
          where: { campaignId: id, variantId, status: { not: "sent" } },
          select: { propertyId: true },
        });
        const propertyIds = [...new Set(unsent.map((d) => d.propertyId))].sort();
        if (propertyIds.length > 0) {
          await tx.$queryRaw`SELECT id FROM properties WHERE id = ANY(${propertyIds}::uuid[]) ORDER BY id FOR UPDATE`;
          const visible = await tx.property.findMany({
            where: {
              id: { in: propertyIds },
              OR: [{ createdBy: session.id }, { assignedTo: session.id }],
            },
            select: { id: true },
          });
          if (visible.length !== propertyIds.length) {
            throw new ApiError(
              403,
              "担当外の宛先を含む型は本文を保存できません",
              "FORBIDDEN",
            );
          }
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
      // ⚠初期化（原本がまだ無かった）のときは消さない。消すべき「旧テンプレ由来の本文」が
      //   存在せず、消すと以前の作り方で入っていた本文を壊すだけになる。
      let clearedCount = 0;
      if (!isInitialization) {
        const cleared = await tx.dmRecipientDraft.updateMany({
          where: {
            campaignId: id,
            variantId,
            status: { not: "sent" },
            body: { not: "" },
            // 担当範囲は上でロック下に確認済みだが、書込条件にも残す（防御の二重化）。
            ...(session.role === "field_staff"
              ? {
                  property: {
                    OR: [
                      { createdBy: session.id },
                      { assignedTo: session.id },
                    ],
                  },
                }
              : {}),
          },
          data: { body: "", status: "draft", confirmedAt: null },
        });
        clearedCount = cleared.count;
      }
      // 保存後の指紋を同じ tx から返す（画面は取り直さずにこれを持つ）。
      return {
        changed: true as const,
        clearedCount,
        bodyDigest: bodyTemplateDigest(parsed.body),
      };
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
