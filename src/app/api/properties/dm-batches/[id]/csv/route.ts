import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
  handleApiError,
  ApiError,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { hasPermission } from "@/lib/permissions";
import { loadImportSourceMap } from "@/lib/property-list-query";
import { isPlainOwnerLevel } from "@/lib/dm-export";
import {
  lockOwnersForShare,
  lockPropertiesForShare,
  type RawTx,
} from "@/lib/dm-batch/locks";
import {
  checkBatchEligibility,
  type BatchItemForCheck,
  type PropertyStateForCheck,
} from "@/lib/dm-batch/eligibility";
import { buildBatchCsv, sha256Hex } from "@/lib/dm-batch/csv";
import {
  readItemsWithOwners,
  itemSetKey,
  collectOwnerIds,
  collectPropertyIds,
  type BatchItemTxLike,
} from "@/lib/dm-batch/items";

// ---------- GET /api/properties/dm-batches/[id]/csv ----------
//
// 宛名CSV出力の第2段「控えからのダウンロード」(設計書§2.1)。CSV は常に保存済み items から
// 生成する(検索条件は再実行しない)。「初回ダウンロード」を境界とするライフサイクル:
//   初回 GET(downloadedAt 未設定)= 現在状態を検証してから配り、配った集合を凍結
//     (downloadedAt+csvDigest+rowCount 再計算)。owner/物件が消えた item は物理削除。
//   再試行 GET(設定済み)= 同じ items から再生成し csvDigest 一致のときだけ配信
//     (内容が変わった控えから別バージョンのCSVを刷らせない)。資格検査は毎回同じ完全形。
// 凍結 tx は共通ロック順序「Owner(FOR SHARE)→物件親行(FOR SHARE)→バッチ行(FOR UPDATE)
// →items 再読取(不一致中止)」に従う(初回GET同士のレース・担当替え・所有者統合と直列化)。
//
// 資格検査(checkBatchEligibility)は (1)scope (3)送付可能+リンク (4)null除外 (6)グループ一致。
// (2)terminal反響=PR-B / (5)再送候補述語=PR-C で同関数に追加される(本 route は不変)。

async function loadPropertyStates(
  tx: {
    property: {
      findMany: (args: unknown) => Promise<
        Array<
          PropertyStateForCheck & {
            address: string | null;
            propertyType: string;
          }
        >
      >;
    };
  },
  propertyIds: string[],
): Promise<Map<string, PropertyStateForCheck & { address: string | null; propertyType: string }>> {
  if (propertyIds.length === 0) return new Map();
  const rows = await tx.property.findMany({
    where: { id: { in: propertyIds } },
    select: {
      id: true,
      dmStatus: true,
      isArchived: true,
      createdBy: true,
      assignedTo: true,
      address: true,
      propertyType: true,
      propertyOwners: {
        where: { owner: { isArchived: false } },
        select: {
          isPrimary: true,
          relationship: true,
          owner: {
            select: {
              id: true,
              name: true,
              nameKana: true,
              zip: true,
              address: true,
              corporateNumber: true,
            },
          },
        },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      },
    },
  });
  return new Map(rows.map((r) => [r.id, r]));
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: batchId } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    // 権限ゲート(POST /dm-batches・旧 export と同一の4権限+表示レベル)。
    if (!hasPermission(permissions, "property", "read")) {
      throw new ApiError(403, "物件一覧の閲覧権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(permissions, "csv_export", "read")) {
      throw new ApiError(403, "CSV エクスポートの権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(permissions, "csv_export_personal", "read")) {
      throw new ApiError(
        403,
        "個人情報を含む CSV エクスポートの権限がありません",
        "FORBIDDEN",
      );
    }
    if (!hasPermission(permissions, "owner", "read")) {
      throw new ApiError(403, "所有者情報の閲覧権限がありません", "FORBIDDEN");
    }
    const ownerDisplayConfig = await getOwnerDisplayConfig(session.id, permissions);
    if (
      !isPlainOwnerLevel(ownerDisplayConfig.name) ||
      !isPlainOwnerLevel(ownerDisplayConfig.zip) ||
      !isPlainOwnerLevel(ownerDisplayConfig.address)
    ) {
      throw new ApiError(
        403,
        "DM差込CSV出力に必要な所有者情報（氏名・郵便番号・住所）の表示権限がありません",
        "FORBIDDEN",
      );
    }

    // 作成者本人のみ(他人の UUID 横断は 404 で存在を漏らさない)。
    const owned = await prisma.dmExportBatch.findFirst({
      where: { id: batchId, createdBy: session.id },
      select: { id: true },
    });
    if (!owned) {
      throw new ApiError(404, "出力の控えが見つかりません", "NOT_FOUND");
    }

    const result = await prisma.$transaction(async (tx) => {
      const rawTx = tx as unknown as RawTx;
      const itemsTx = tx as unknown as BatchItemTxLike;
      const propsTx = tx as unknown as Parameters<typeof loadPropertyStates>[0];

      // 先読み(ロックなし)→ Owner→物件親行→バッチ行の順でロック(順序規約§2.2)。
      const pre = await readItemsWithOwners(itemsTx, batchId);
      await lockOwnersForShare(rawTx, collectOwnerIds(pre));
      await lockPropertiesForShare(rawTx, collectPropertyIds(pre));
      const batchRows = await rawTx.$queryRaw<
        Array<{
          id: string;
          downloaded_at: Date | null;
          csv_digest: string | null;
          resend_filter_applied: boolean;
        }>
      >`SELECT id, downloaded_at, csv_digest, resend_filter_applied FROM dm_export_batches WHERE id = ${batchId}::uuid FOR UPDATE`;
      if (batchRows.length === 0) {
        throw new ApiError(404, "出力の控えが見つかりません", "NOT_FOUND");
      }
      const batchRow = batchRows[0];

      // ロック保持後に items を再読取。先読みと集合が違えば中止(初回GET同士・統合とのレース)。
      const items = await readItemsWithOwners(itemsTx, batchId);
      if (itemSetKey(pre) !== itemSetKey(items)) {
        throw new ApiError(
          409,
          "宛先の状態が変わりました。もう一度開いてください",
          "RETRY",
        );
      }

      const properties = await loadPropertyStates(propsTx, collectPropertyIds(items));
      const elig = checkBatchEligibility(items, properties, session);

      if (elig.scopeMissingCount > 0) {
        throw new ApiError(
          403,
          `担当範囲が変わったため出力できません(${elig.scopeMissingCount}件)。再出力してください`,
          "FORBIDDEN",
        );
      }
      if (elig.stateIssueCount > 0 || elig.groupMismatchCount > 0) {
        throw new ApiError(
          409,
          "宛先の状態が変わったため、この控えは使えません。再出力してください",
          "REEXPORT_REQUIRED",
        );
      }

      const isFirst = batchRow.downloaded_at == null;
      if (elig.prunedItemIds.length > 0) {
        if (!isFirst) {
          // DL後に owner/物件が消えた=同一CSVを再生成できない(凍結済み集合の変質)。
          throw new ApiError(
            409,
            "内容が変わったため再出力してください",
            "REEXPORT_REQUIRED",
          );
        }
        await tx.dmExportBatchItem.deleteMany({
          where: { id: { in: elig.prunedItemIds } },
        });
      }

      const pruned = new Set(elig.prunedItemIds);
      const survive = items.filter((it) => !pruned.has(it.id));
      const csvItems = survive.map((it) => ({
        id: it.id,
        propertyId: it.propertyId as string,
        ownerId: it.ownerId as string,
        groupOwnerIds: it.groupOwnerIds,
      }));
      // loadImportSourceMap は読み取りのみ(importJobRow.findMany)。型は full client を
      // 要求するが tx でも同メソッドを持つため、tx 内の一貫読取としてそのまま渡す。
      const importSourceMap = await loadImportSourceMap(
        tx as unknown as typeof prisma,
        csvItems.map((it) => it.propertyId),
      );
      const csv = buildBatchCsv({
        items: csvItems,
        properties,
        importSourceMap,
        ownerDisplayConfig,
      });
      const digest = sha256Hex(csv);

      if (isFirst) {
        await tx.dmExportBatch.update({
          where: { id: batchId },
          data: {
            downloadedAt: new Date(),
            csvDigest: digest,
            rowCount: survive.length,
          },
        });
      } else if (digest !== batchRow.csv_digest) {
        // 氏名・住所・物件情報が初回DL後に変わった=中身の違うCSVを同じ控えから刷らせない。
        throw new ApiError(
          409,
          "内容が変わったため再出力してください",
          "REEXPORT_REQUIRED",
        );
      }

      return { csv, retry: !isFirst, count: survive.length };
    });

    // PII 開示の操作監査(成功時のみ・detail は非PII)。
    await writeAuditLog({
      userId: session.id,
      action: "property_dm_csv_export",
      targetTable: "dm_export_batches",
      targetId: batchId,
      detail: {
        batchId,
        retry: result.retry,
        count: result.count,
        exportedAt: new Date().toISOString(),
      },
    });

    const fileDate = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    return new NextResponse(result.csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="dm_merge_${fileDate}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
