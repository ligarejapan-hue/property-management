import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError, parseJsonBody } from "@/lib/api-helpers";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { isSaleDmConfigured, generateLetters, resolveProvider } from "@/lib/sale-dm-letter";
import { resolveSender, isSenderConfigured } from "@/lib/sale-dm-letter/sender";
import { resolveTrackingBaseUrl, resolveLpUrl } from "@/lib/sale-dm-letter/tracking";
import { loadSaleDmConfig } from "@/lib/sale-dm-letter/config-store";
import { resolveDraftOptions } from "@/lib/sale-dm-letter/override";
import { PROPERTY_TYPE_LABELS } from "@/lib/property-types";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { session, permissions } = await requireSaleDmAccess();
    // 再生成も有料AI呼び出し(1通)+ オーナーPII の外部送信のため sale_dm:generate を必須化(campaign 作成と統一)。
    if (!hasPermission(permissions, "sale_dm", "generate")) throw new ApiError(403, "AIによるDM生成の権限がありません", "FORBIDDEN");
    // 売却DM 設定は DB→env で解決(管理画面の設定を反映)。
    const saleDmCfg = await loadSaleDmConfig();
    if (!isSaleDmConfigured(saleDmCfg)) throw new ApiError(503, "売却DM生成が未設定です", "NOT_CONFIGURED");
    // 差出人未設定なら fail-closed。resolveSender の "(差出人名 未設定)"/空 で再生成すると
    // 差出人欄が使えない手紙になるため、有料生成の前に弾く(campaign 作成と同方針)。
    if (!isSenderConfigured(saleDmCfg)) throw new ApiError(503, "差出人情報(差出人名 / 連絡先)が未設定です", "SENDER_NOT_CONFIGURED");
    // 印刷の郵送QRには絶対URL(追跡URL / LP URL)が必須。未設定だと再生成(課金)しても印刷 route が 503 で
    // 出力できず、印刷不能な下書きに課金されるだけになる。生成前に確認し fail-closed(campaign POST と統一)。
    if (!resolveTrackingBaseUrl(saleDmCfg) || !resolveLpUrl(saleDmCfg)) throw new ApiError(503, "印刷に必要なURL(追跡URL / LP URL)が未設定です", "PRINT_URL_NOT_CONFIGURED");
    // 課金確認: 再生成も有料AI+PII外部送信のため、campaign 作成と同じく明示確認(confirmed:true)を要求する。
    // stale tab/誤クリックの1クリックで無確認の課金・PII送信が起きないようにする(UI は確認後 true を送る)。
    const requestBody = await parseJsonBody(request);
    if ((requestBody as { confirmed?: unknown }).confirmed !== true) {
      throw new ApiError(400, "再生成には課金確認(confirmed:true)が必要です", "SALE_DM_CONFIRMATION_REQUIRED");
    }
    const { id } = await params;
    const draft = await prisma.dmRecipientDraft.findUnique({ where: { id }, include: { variant: true, property: { select: { address: true, propertyType: true, roomNo: true, createdBy: true, assignedTo: true } }, campaign: { select: { createdBy: true } } } });
    // 作成者本人のキャンペーン配下のみ(横断アクセス防止)。not-found/not-owned は同じ 404。
    if (!draft || draft.campaign.createdBy !== session.id) throw new ApiError(404, "下書きが見つかりません", "NOT_FOUND");
    // field_staff は作成 or 担当の物件のみ操作可(物件APIと同じ record scope。再割当で範囲外に
    // なった物件の宛先PIIを生成器へ渡させない)。GET/print/export の絞り込みと整合。
    if (
      session.role === "field_staff" &&
      draft.property.createdBy !== session.id &&
      draft.property.assignedTo !== session.id
    ) {
      throw new ApiError(403, "この物件を操作する権限がありません", "FORBIDDEN");
    }
    // 送付済み(sent)の宛先は再生成(本文書き換え)できない(送った内容/集計の改竄防止)。
    if (draft.status === "sent") throw new ApiError(409, "送付済みの宛先は再生成できません", "ALREADY_SENT");
    const v = draft.variant;
    const sender = resolveSender(saleDmCfg);
    const { drafts } = await generateLetters([{
      recipient: {
        representativeName: draft.recipientName, honorific: draft.honorific, coOwnerCount: draft.coOwnerCount,
        propertyAddress: draft.property.address, propertyTypeLabel: PROPERTY_TYPE_LABELS[draft.property.propertyType] ?? draft.property.propertyType, roomNo: draft.property.roomNo,
      },
      // 割り当てられた型(variant)の設定に、この通だけの個別上書き(overrideJson)を
      // merge して options を組み立てる(集計は variantId 基準・override は本文の微修正のみ)。
      options: resolveDraftOptions(
        { designTemplate: v.designTemplate, tone: v.tone, length: v.length, appeal: v.appeal, strength: v.strength, extraInstruction: v.extraInstruction },
        draft.overrideJson as Parameters<typeof resolveDraftOptions>[1],
        sender,
      ),
    }], { provider: resolveProvider(saleDmCfg) });
    const body = drafts[0]?.body;
    if (!body) throw new ApiError(502, "再生成に失敗しました", "GENERATION_FAILED");
    // 生成は外部呼び出しで時間がかかり、その間に並行で (a) sent 確定 / (b) 割当 variant の設定変更 が起こり得る。
    // 条件付き updateMany でアトミックに弾く: status!=sent に加え、draft の variant が「生成時と同一 options」で
    // あることを relational filter で要求する。生成中に型が変わっていれば 0 行となり、旧設定の本文で書き戻して
    // variant 更新 route の無効化(A/B 整合)を打ち消すことを防ぐ。本文が変わるため確定も解除(draft へ・
    // confirmedAt 消去)し、再生成後の新文面を再確認なしで印刷/送付させない(承認ゲート維持)。
    const updated = await prisma.dmRecipientDraft.updateMany({
      where: {
        id,
        status: { not: "sent" },
        variant: {
          designTemplate: v.designTemplate,
          tone: v.tone,
          length: v.length,
          appeal: v.appeal,
          strength: v.strength,
          extraInstruction: v.extraInstruction,
        },
      },
      data: { body, status: "draft", confirmedAt: null },
    });
    if (updated.count === 0) {
      throw new ApiError(409, "送付済み、または生成中に型の設定が変更されました。最新の設定で再生成してください", "STALE_REGENERATION");
    }
    // 再生成も有料AI呼び出し+オーナーPII の外部送信を伴うため、campaign 作成/下書き編集と同様に
    // 非PII の監査を残す(初回作成以降の課金/PII外部送信を管理画面で追跡可能に)。本文・宛名は残さない。
    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_draft_regenerate",
      targetTable: "dm_recipient_drafts",
      targetId: id,
      detail: { campaignId: draft.campaignId, propertyId: draft.propertyId, regeneratedAt: new Date().toISOString() },
    });
    return NextResponse.json({ id, body }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return handleApiError(error); }
}
