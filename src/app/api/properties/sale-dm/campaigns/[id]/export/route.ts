import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { lockOwnersForShare, lockPropertiesForShare, type RawTx } from "@/lib/dm-batch/locks";
import {
  findTerminalExclusions,
  isTerminalExcluded,
  type TerminalExclusionTx,
} from "@/lib/dm-batch/terminal-exclusion";
import { requireSaleDmAccess, filterDraftsByFieldStaffScope } from "@/lib/sale-dm-letter/route-guard";
import { encodeCsv, sanitizeCsvCellForExcel } from "@/lib/csv-encode";
import {
  SALE_DM_CSV_HEADERS,
  buildSaleDmCsvRow,
  type SaleDmCsvRecord,
} from "@/lib/sale-dm-letter/csv";
import { composeAddresseeHonorific } from "@/lib/sale-dm-letter/recipients";

// キャンペーンの全下書きを「設定一式 + 宛名 + 本文 + 状態」の CSV にして返す。
// PII(本文・宛名・住所)を含むため no-store。AuditLog には件数等の非PIIメタのみ残す。
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id } = await params;

    const campaign = await prisma.dmCampaign.findUnique({ where: { id } });
    // 作成者本人のキャンペーンのみ出力可(横断アクセス=範囲外PII漏洩防止)。not-found/not-owned は 404。
    if (!campaign || campaign.createdBy !== session.id) {
      throw new ApiError(404, "キャンペーンが見つかりません", "NOT_FOUND");
    }

    const drafts = await prisma.dmRecipientDraft.findMany({
      where: { campaignId: id },
      orderBy: { createdAt: "asc" },
      include: { variant: true, property: { select: { createdBy: true, assignedTo: true } }, draftOwners: { select: { ownerId: true } } },
    });
    // field_staff は現在の物件 record scope の宛先のみ出力(GET campaign と統一)。
    const visibleDrafts = filterDraftsByFieldStaffScope(drafts, session);

    // 拒否・宛先不明(terminal 反響)の宛先が混ざっていたら**出力全体を断る**(@codex #384 R2 P1)。
    // この CSV は差し込み印刷の元=最終出力の1つ。作成後に記録された拒否が素通りすると、
    // 印刷・確定の関所を避けて手紙が作れてしまう。A(宛名CSV)の DL 時再検査と同じ扱い。
    // ⚠CSV の実体化(行の構築)まで Owner FOR SHARE を保持した tx 内で行う=検査と出力の
    // 間に terminal writer が commit する窓を作らない(印刷 route と同じ境界の置き方)。
    const csv = await prisma.$transaction(async (tx) => {
      const ownerIds = [
        ...new Set(
          visibleDrafts.flatMap((d) => [
            ...(d.representativeOwnerId ? [d.representativeOwnerId] : []),
            ...(d.draftOwners ?? []).map((o) => o.ownerId),
          ]),
        ),
      ];
      await lockOwnersForShare(tx as unknown as RawTx, ownerIds);
      // 所有者なしの terminal 記録の書き手は物件行で直列化するため物件親行も取る(@codex R3 P1)。
      const propertyIds = [...new Set(visibleDrafts.map((d) => d.propertyId))];
      await lockPropertiesForShare(tx as unknown as RawTx, propertyIds);
      // ロック取得後に読み直す(@codex R3 P1: 事前読取〜ロックの間の所有者統合で
      // 連関が master へ付け替わると、古いIDだけを照会して除外を取りこぼす)。
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
        return [
          ...(r.representativeOwnerId ? [r.representativeOwnerId] : []),
          ...(r.draftOwners ?? []).map((o) => o.ownerId),
        ].some((oid) => !lockedOwners.has(oid));
      });
      if (changed) {
        throw new ApiError(409, "宛先の状態が変わりました。もう一度お試しください", "RETRY");
      }
      const exclusionSets = await findTerminalExclusions(
        tx as unknown as TerminalExclusionTx,
        ownerIds,
        propertyIds,
      );
      const terminalCount = visibleDrafts.filter((d) => {
        const r = rereadById.get(d.id);
        return isTerminalExcluded(exclusionSets, {
          propertyId: d.propertyId,
          ownerIds: [
            ...(r?.representativeOwnerId ? [r.representativeOwnerId] : []),
            ...(r?.draftOwners ?? []).map((o) => o.ownerId),
          ],
        });
      }).length;
      if (terminalCount > 0) {
        throw new ApiError(
          409,
          `拒否・宛先不明が記録された宛先が ${terminalCount} 件含まれています(その方の別物件での記録も含みます)。宛先を作り直してから出力してください`,
          "TERMINAL_RECIPIENTS",
        );
      }
      const records: SaleDmCsvRecord[] = visibleDrafts.map((d) => ({
        variantLabel: d.variant.label,
        designTemplate: d.variant.designTemplate,
        tone: d.variant.tone,
        length: d.variant.length,
        appeal: d.variant.appeal,
        strength: d.variant.strength,
        recipientName: d.recipientName,
        honorific: composeAddresseeHonorific(d.honorific, d.coOwnerCount),
        recipientZip: d.recipientZip,
        recipientAddress: d.recipientAddress,
        status: d.status,
        body: d.body,
      }));

      // 各セルを formula injection 対策で無害化してから encodeCsv(BOM+CRLF)へ。
      const sanitizedRows = records.map((record) => {
        const row = buildSaleDmCsvRow(record);
        return Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            sanitizeCsvCellForExcel(value),
          ]),
        );
      });

      const csv = encodeCsv([...SALE_DM_CSV_HEADERS], sanitizedRows, { bom: true });
      return csv;
    });

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_campaign_csv_export",
      targetTable: "dm_campaigns",
      detail: {
        campaignId: id,
        // 全か無かで出力するため、出力できた=可視の全件(terminal 混入時はここへ到達しない)。
        count: visibleDrafts.length,
        exportedAt: new Date().toISOString(),
      },
    });

    const fileDate = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="sale_dm_${fileDate}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
