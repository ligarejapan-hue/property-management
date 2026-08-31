import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { requireSaleDmAccess, filterDraftsByFieldStaffScope } from "@/lib/sale-dm-letter/route-guard";
import { writeAuditLog } from "@/lib/audit";
import { lockOwnersForShare, lockPropertiesForShare, type RawTx } from "@/lib/dm-batch/locks";
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
import { buildTrackingQrSvg } from "@/lib/sale-dm-letter/qr";
import { renderUnsubscribeSlotHtml } from "@/lib/sale-dm-letter/unsubscribe-slot";
import {
  buildUnsubscribeToken,
  buildUnsubscribeUrl,
  deriveUnsubscribeKey,
} from "@/lib/sale-dm-letter/unsubscribe-token";
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
    // 配信停止QRの署名鍵(NEXTAUTH_SECRET 由来)。無ければ署名できない=停止QRの無い
    // 手紙を黙って刷らず fail-closed(503)。通常運用では next-auth の前提のため常に在る。
    let unsubscribeKey: Buffer;
    try {
      unsubscribeKey = deriveUnsubscribeKey();
    } catch {
      throw new ApiError(503, "配信停止QRの署名鍵を導出できません(NEXTAUTH_SECRET 未設定)", "UNSUBSCRIBE_KEY_NOT_CONFIGURED");
    }

    // 拒否・宛先不明(terminal 反響)は**印刷の直前にもう一度**検査して除外する
    // (@codex #384 R1 P1)。さらに、**印刷物(QR+HTML)の実体化までロック内で行う**
    // (@codex #384 R2 P1): 除外判定だけ tx に入れて描画を外へ出すと、tx 終了〜描画の
    // すき間に terminal writer が commit でき、選ばれ済みの宛先がそのまま刷られる。
    // A(宛名CSV)が CSV の実体化を関所の内側で行うのと同じ境界の置き方。
    // 宛先ゼロでもこの経路を通る(ロックは空で no-op・空ドキュメントを返す)。
    const materialized = await prisma.$transaction(async (tx) => {
      const ownerIds = [
        ...new Set(
          visibleDrafts.flatMap((d) => [
            ...(d.representativeOwnerId ? [d.representativeOwnerId] : []),
            ...(d.draftOwners ?? []).map((o) => o.ownerId),
          ]),
        ),
      ];
      await lockOwnersForShare(tx as unknown as RawTx, ownerIds);
      // 所有者なしの terminal 記録の書き手は**物件行**で直列化するため、物件親行も取る
      // (@codex #384 R3 P1)。順序は Owner → 物件親行(§2.3 に整合・variant は読まない)。
      const propertyIds = [...new Set(visibleDrafts.map((d) => d.propertyId))];
      await lockPropertiesForShare(tx as unknown as RawTx, propertyIds);
      // ⚠**ロック取得後に読み直す**(@codex #384 R3 P1)。事前読取〜ロックの間に所有者
      // 統合(merge)が commit すると、draft の連関と terminal 記録は master 所有者へ
      // 付け替わり、**古い所有者IDだけをロック・照会**して除外を取りこぼす。
      // 読み直した所有者集合がロック済み集合の中に収まらなければ、負けを認めて 409。
      const reread = await tx.dmRecipientDraft.findMany({
        where: { id: { in: visibleDrafts.map((d) => d.id) } },
        select: {
          id: true,
          propertyId: true,
          representativeOwnerId: true,
          draftOwners: { select: { ownerId: true } },
        },
      });
      const lockedOwners = new Set(ownerIds);
      const rereadById = new Map(reread.map((r) => [r.id, r]));
      const changed = visibleDrafts.some((d) => {
        const r = rereadById.get(d.id);
        if (!r || r.propertyId !== d.propertyId) return true;
        const owners = [
          ...(r.representativeOwnerId ? [r.representativeOwnerId] : []),
          ...(r.draftOwners ?? []).map((o) => o.ownerId),
        ];
        return owners.some((oid) => !lockedOwners.has(oid));
      });
      if (changed) {
        throw new ApiError(
          409,
          "宛先の状態が変わりました。もう一度お試しください",
          "RETRY",
        );
      }
      const ownerIdsByDraft = new Map(
        reread.map((r) => [
          r.id,
          [
            ...(r.representativeOwnerId ? [r.representativeOwnerId] : []),
            ...(r.draftOwners ?? []).map((o) => o.ownerId),
          ],
        ]),
      );
      const exclusionSets = await findTerminalExclusions(
        tx as unknown as TerminalExclusionTx,
        ownerIds,
        propertyIds,
      );
      const printableDrafts = visibleDrafts.filter(
        (d) =>
          !isTerminalExcluded(exclusionSets, {
            propertyId: d.propertyId,
            ownerIds: ownerIdsByDraft.get(d.id) ?? [],
          }),
      );
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
          // 配信停止QR: `<trackingToken>.<HMAC署名>` を /u/ へ。追跡トークン単体では
          // 停止できない(署名は紙面にしか存在しない)。追跡枠へ**連結**して差し込む
          // (テンプレの slot 契約は据え置き)。
          const unsubscribeUrl = buildUnsubscribeUrl(
            buildUnsubscribeToken(d.trackingToken, unsubscribeKey),
            trackingBaseUrl,
          );
          const unsubscribeSlotHtml = renderUnsubscribeSlotHtml({
            url: unsubscribeUrl,
            qrSvg: await buildTrackingQrSvg(unsubscribeUrl),
          });
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
            trackingSlotHtml:
              renderTrackingSlotHtml(artifacts, { caption: "スマホで読み取り(無料査定)" }) +
              unsubscribeSlotHtml,
          };
        }),
      );
      return {
        html: renderLetterSheetHtml(campaign.name, letters),
        excludedTerminalCount,
        printedCount: printableDrafts.length,
      };
    });
    const { excludedTerminalCount, printedCount } = materialized;
    let html = materialized.html;
    if (excludedTerminalCount > 0) {
      // 黙って減らさない: 何通除外したかを**画面にだけ**示す(@codex #384 R2 P2)。
      // この文書は印刷用に開かれるため、素の div だと1通目の手紙の直前に
      // 内部運用の注意書きが**お客様の紙面へ**刷り込まれる。@media print で隠す。
      html = html.replace(
        /<body([^>]*)>/,
        `<body$1><style>@media print{.pm-terminal-note{display:none !important}}</style><div class="pm-terminal-note" style="padding:8px 12px;border:2px solid #a00;margin:8px;font-size:14px">⚠拒否・宛先不明が記録された ${excludedTerminalCount} 件の宛先は、この印刷から除外しました(画面表示のみ・印刷には出ません)。</div>`,
      );
    }

    // 印刷出力(PII含むHTML)を非PIIメタで監査(CSV出力 route と統一・dashboard 外の直GETも追跡可能に)。
    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_campaign_print",
      targetTable: "dm_campaigns",
      // field_staff は visibleDrafts のみ印刷されるため、監査件数も実際に出力した可視分を記録する
      // (drafts.length だと担当外で隠れた宛先まで数えて実出力数を過大計上する)。
      detail: { campaignId: id, count: printedCount, excludedTerminal: excludedTerminalCount, printedAt: new Date().toISOString() },
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
