import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { requireSaleDmAccess, filterDraftsByFieldStaffScope } from "@/lib/sale-dm-letter/route-guard";
import { writeAuditLog } from "@/lib/audit";
import { lockOwnersForShare, type RawTx } from "@/lib/dm-batch/locks";
import {
  findTerminalExclusions,
  isTerminalExcluded,
  type TerminalExclusionTx,
} from "@/lib/dm-batch/terminal-exclusion";
import {
  renderLetterSheetHtml,
  type LetterRenderInput,
} from "@/lib/sale-dm-letter/templates";
import { resolveSender, isSenderConfigured } from "@/lib/sale-dm-letter/sender";
import { resolveTrackingBaseUrl, resolveLpUrl } from "@/lib/sale-dm-letter/tracking";
import { loadSaleDmConfig } from "@/lib/sale-dm-letter/config-store";
import { buildTrackingArtifacts } from "@/lib/sale-dm-letter/qr";
import { renderTrackingSlotHtml } from "@/lib/sale-dm-letter/tracking-slot";
import { composeAddresseeHonorific } from "@/lib/sale-dm-letter/recipients";

// 確定済み(status=confirmed)の全通をページ区切りで連結した印刷用 HTML を返す。
// PII(本文・宛名・住所)を含むため no-store。本文は AuditLog に残さない。
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id } = await params;

    const campaign = await prisma.dmCampaign.findUnique({ where: { id } });
    // 作成者本人のキャンペーンのみ印刷可(横断アクセス=範囲外PII漏洩防止)。not-found/not-owned は 404。
    if (!campaign || campaign.createdBy !== session.id) {
      throw new ApiError(404, "キャンペーンが見つかりません", "NOT_FOUND");
    }

    // 確定分のみ・作成順。variant は設定一式(designTemplate 等)を引くために include。
    const drafts = await prisma.dmRecipientDraft.findMany({
      // confirmed かつ body あり(生成失敗の空letterは印刷しない=空の郵送物を防ぐ)。
      where: { campaignId: id, status: "confirmed", body: { not: "" } },
      orderBy: { createdAt: "asc" },
      include: { variant: true, property: { select: { createdBy: true, assignedTo: true } }, draftOwners: { select: { ownerId: true } } },
    });
    // field_staff は現在の物件 record scope の宛先のみ印刷(GET campaign / CSV と統一)。
    const visibleDrafts = filterDraftsByFieldStaffScope(drafts, session);



    // 売却DM 設定は DB→env で解決(管理画面の設定を反映)。
    const saleDmCfg = await loadSaleDmConfig();
    const { senderName, senderContact } = resolveSender(saleDmCfg);
    // 追跡QR/短縮URL は宛先固有の opaque トークンから生成する。郵送物(印刷)の QR は
    // 絶対URLが必須(相対パスは scheme/host が無く郵送先で機能しない)ため、base 未設定は
    // fail-closed(503)。本番は追跡用URLの設定必須。
    const trackingBaseUrl = resolveTrackingBaseUrl(saleDmCfg);
    if (!trackingBaseUrl) {
      throw new ApiError(503, "追跡用URLが未設定です。郵送QRには絶対URLが必要です", "TRACKING_NOT_CONFIGURED");
    }
    // 郵送QRの遷移先 LP も絶対URL必須。未設定/非絶対だと QR を踏んでも /t/ が 404 になり郵送物が
    // dead-link になるため、印刷前に fail-closed(503)。
    if (!resolveLpUrl(saleDmCfg)) {
      throw new ApiError(503, "LP URLが未設定/不正です。郵送QRの遷移先に絶対URLが必要です", "LP_NOT_CONFIGURED");
    }
    // 差出人が外れていると resolveSender が "(差出人名 未設定)"/空 を返し、差出人欄が不正な郵送物になる。
    // 生成/再生成と同様、印刷も差出人未設定なら fail-closed(503)する(郵送前に止める)。
    if (!isSenderConfigured(saleDmCfg)) {
      throw new ApiError(503, "差出人情報(差出人名 / 連絡先)が未設定です", "SENDER_NOT_CONFIGURED");
    }

    // 拒否・宛先不明(terminal 反響)は**印刷の直前にもう一度**検査して除外する
    // (@codex #384 R1 P1)。作成時の除外だけだと、作成〜印刷の間に記録された拒否が
    // 素通りする。A(宛名CSV)の DL 時再検査と同じ関所を、B の最終出力(印刷)にも置く。
    // Owner FOR SHARE を保持した tx 内で読む=terminal writer と直列化(除外判定だけを
    // tx で行い、レンダリングは外で行う)。
    const terminalDraftIds = visibleDrafts.length === 0
      ? new Set<string>()
      : await prisma.$transaction(async (tx) => {
      const ownerIds = [
        ...new Set(
          visibleDrafts.flatMap((d) => [
            ...(d.representativeOwnerId ? [d.representativeOwnerId] : []),
            ...(d.draftOwners ?? []).map((o) => o.ownerId),
          ]),
        ),
      ];
      await lockOwnersForShare(tx as unknown as RawTx, ownerIds);
      const exclusionSets = await findTerminalExclusions(
        tx as unknown as TerminalExclusionTx,
        ownerIds,
        [...new Set(visibleDrafts.map((d) => d.propertyId))],
      );
      return new Set(
        visibleDrafts
          .filter((d) =>
            isTerminalExcluded(exclusionSets, {
              propertyId: d.propertyId,
              ownerIds: [
                ...(d.representativeOwnerId ? [d.representativeOwnerId] : []),
                ...(d.draftOwners ?? []).map((o) => o.ownerId),
              ],
            }),
          )
          .map((d) => d.id),
      );
    });
    const printableDrafts = visibleDrafts.filter((d) => !terminalDraftIds.has(d.id));
    const excludedTerminalCount = visibleDrafts.length - printableDrafts.length;
    // 全滅なら白紙を刷らせず理由を返す(作成時の ALL_EXCLUDED_TERMINAL と同じ扱い)。
    if (printableDrafts.length === 0 && visibleDrafts.length > 0) {
      throw new ApiError(
        409,
        "確定済みの宛先はすべて拒否・宛先不明が記録されたため印刷できません。宛先を作り直してください",
        "ALL_EXCLUDED_TERMINAL",
      );
    }

    const letters: LetterRenderInput[] = await Promise.all(
      printableDrafts.map(async (d) => {
        const artifacts = await buildTrackingArtifacts(d.trackingToken, trackingBaseUrl);
        return {
          designTemplate: d.variant.designTemplate,
          body: d.body,
          addresseeName: d.recipientName,
          honorific: composeAddresseeHonorific(d.honorific, d.coOwnerCount),
          recipientZip: d.recipientZip,
          recipientAddress: d.recipientAddress,
          senderName,
          senderContact,
          trackingToken: d.trackingToken,
          trackingSlotHtml: renderTrackingSlotHtml(artifacts, { caption: "スマホで読み取り(無料査定)" }),
        };
      }),
    );

    let html = renderLetterSheetHtml(campaign.name, letters);
    if (excludedTerminalCount > 0) {
      // 黙って減らさない: 何通除外したかを印刷物の先頭に1行で示す(非PII=件数のみ)。
      html = html.replace(
        /<body([^>]*)>/,
        `<body$1><div style="padding:8px 12px;border:2px solid #a00;margin:8px;font-size:14px">⚠拒否・宛先不明が記録された ${excludedTerminalCount} 件の宛先は、この印刷から除外しました。</div>`,
      );
    }

    // 印刷出力(PII含むHTML)を非PIIメタで監査(CSV出力 route と統一・dashboard 外の直GETも追跡可能に)。
    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_campaign_print",
      targetTable: "dm_campaigns",
      // field_staff は visibleDrafts のみ印刷されるため、監査件数も実際に出力した可視分を記録する
      // (drafts.length だと担当外で隠れた宛先まで数えて実出力数を過大計上する)。
      detail: { campaignId: id, count: printableDrafts.length, excludedTerminal: excludedTerminalCount, printedAt: new Date().toISOString() },
    });

    return new NextResponse(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
