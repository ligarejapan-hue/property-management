import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
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
      include: { variant: true },
    });

    const records: SaleDmCsvRecord[] = drafts.map((d) => ({
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

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_campaign_csv_export",
      targetTable: "dm_campaigns",
      detail: {
        campaignId: id,
        count: records.length,
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
