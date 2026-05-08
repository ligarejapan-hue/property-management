import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { hasPermission } from "@/lib/permissions";
import { parseSheet, SheetParseError } from "@/lib/sheet-parser";
import { detectImportFileType } from "@/lib/import-file-type";
import { recordChanges, PROPERTY_TRACKED_FIELDS } from "@/lib/change-log";
import {
  parseReceptionRows,
  parseOwnerRows,
  buildCombinedMatches,
  summarizeMatches,
  getReviewReason,
  applyReceptionFilters,
  DEFAULT_RECEPTION_FILTER_OPTIONS,
  REVIEW_REASON_LABEL,
  type PropertyCandidate,
  type ParsedOwnerRow,
  type DlFilterMode,
  type ShinkiFilterMode,
} from "@/lib/reception-owner-match";
import { buildErrorRawDataExtras } from "@/lib/import-error-display";
import { RECEPTION_OWNER_LINK_DATA_KEY } from "@/lib/reception-owner-link";

// 受付帳CSV × 所有者CSV × 既存物件 の本実行。
// - 一意特定できた行だけ反映。それ以外は needs_review で記録。
// - Property: lotNumber / buildingNumber / roomNo は空値で上書きしない（ブランクのみ補完）。
// - Owner: name + address で upsert。存在すれば再利用、なければ作成。
// - PropertyOwner: 同じ (propertyId, ownerId) が無ければ作成（共有名義に対応）。
// - Building は扱わない（棟名で全ユニットが影響されるため）。

function toPositionalRows(
  headers: string[],
  rows: readonly Record<string, string>[],
): string[][] {
  return rows.map((r) => headers.map((h) => r[h] ?? ""));
}

function nullIfBlank(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "import", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const body = await request.json();
    const {
      receptionCsv,
      ownerCsv,
      receptionXlsxBase64,
      ownerXlsxBase64,
      receptionFileName,
      ownerFileName,
      dlFilter,
      shinkiFilter,
    } = body as {
      receptionCsv?: string;
      ownerCsv?: string;
      receptionXlsxBase64?: string;
      ownerXlsxBase64?: string;
      receptionFileName?: string;
      ownerFileName?: string;
      dlFilter?: DlFilterMode;
      shinkiFilter?: ShinkiFilterMode;
    };
    const filterOptions = {
      dl: dlFilter ?? DEFAULT_RECEPTION_FILTER_OPTIONS.dl,
      shinki: shinkiFilter ?? DEFAULT_RECEPTION_FILTER_OPTIONS.shinki,
    };

    if (!receptionFileName || !ownerFileName) {
      throw new ApiError(
        422,
        "receptionFileName と ownerFileName は必須です",
        "VALIDATION_ERROR",
      );
    }
    if ((!receptionCsv && !receptionXlsxBase64) || (!ownerCsv && !ownerXlsxBase64)) {
      throw new ApiError(
        422,
        "受付帳・所有者それぞれ csv または xlsx のいずれかを指定してください",
        "VALIDATION_ERROR",
      );
    }

    const receptionDetect = detectImportFileType(receptionFileName);
    const ownerDetect = detectImportFileType(ownerFileName);
    if (receptionDetect.type !== "reception") {
      throw new ApiError(
        422,
        `受付帳ファイルとして認識できません: ${receptionDetect.error ?? "ファイル名に『受付帳』を含めてください"}`,
        "VALIDATION_ERROR",
      );
    }
    if (ownerDetect.type !== "owner") {
      throw new ApiError(
        422,
        `所有者ファイルとして認識できません: ${ownerDetect.error ?? "ファイル名に『所有者』を含めてください"}`,
        "VALIDATION_ERROR",
      );
    }

    // パース（csv / xlsx 共通）
    let receptionParsed: ReturnType<typeof parseSheet>;
    let ownerParsed: ReturnType<typeof parseSheet>;
    try {
      receptionParsed = parseSheet({
        fileName: receptionFileName,
        csvText: receptionCsv,
        xlsxBase64: receptionXlsxBase64,
      });
      ownerParsed = parseSheet({
        fileName: ownerFileName,
        csvText: ownerCsv,
        xlsxBase64: ownerXlsxBase64,
      });
    } catch (e) {
      if (e instanceof SheetParseError) {
        throw new ApiError(422, e.message, e.code);
      }
      throw e;
    }
    const receptionRows = applyReceptionFilters(
      parseReceptionRows(
        toPositionalRows(receptionParsed.headers, receptionParsed.rows),
      ),
      filterOptions,
    );
    const ownerRows = parseOwnerRows(
      ownerParsed.headers,
      toPositionalRows(ownerParsed.headers, ownerParsed.rows),
    );

    // 既存物件
    const existing = await prisma.property.findMany({
      select: {
        id: true,
        address: true,
        lotNumber: true,
        buildingNumber: true,
        roomNo: true,
        building: { select: { name: true } },
      },
    });
    const candidates: PropertyCandidate[] = existing.map((p) => ({
      id: p.id,
      address: p.address ?? "",
      lotNumber: p.lotNumber ?? null,
      buildingNumber: p.buildingNumber ?? null,
      buildingName: p.building?.name ?? null,
      roomNo: p.roomNo ?? null,
    }));

    const combined = buildCombinedMatches(receptionRows, ownerRows, candidates);
    const summary = summarizeMatches(receptionRows, ownerRows.length, combined);

    // ImportJob（既存の jobType enum を流用。reception_owner は owner_csv 扱い）
    const job = await prisma.importJob.create({
      data: {
        jobType: "owner_csv",
        fileName: `${receptionFileName ?? "reception.csv"} + ${ownerFileName ?? "owner.csv"}`,
        status: "processing",
        totalRows: receptionRows.length,
        executedBy: session.id,
        startedAt: new Date(),
      },
    });

    let successCount = 0;
    let needsReviewCount = 0;
    let errorCount = 0;
    let propertyUpdatedCount = 0;
    let ownerCreatedCount = 0;
    let ownerLinkedCount = 0;

    for (const c of combined) {
      const reason = getReviewReason(c);
      const rowNumber = c.reception.rowNumber;
      // 所有者側の DM フラグ・物件住所も rawData に集約（複数件の場合はカンマ区切り）
      const ownerDmList = c.owners
        .map((o) => (o.dm ?? "").trim())
        .filter((v) => v !== "");
      const ownerPropAddrList = c.owners
        .map((o) => (o.propertyAddress ?? "").trim())
        .filter((v) => v !== "");
      // 手動紐づけ (manual-link-reception-owner) で Owner upsert に使う構造化情報。
      // __ プレフィックスは UI / export から除外される内部用フィールド。
      const ownerLinkData = c.owners
        .filter((o) => o.name && o.name.trim() !== "")
        .map((o) => ({ name: o.name, address: o.address, zip: o.zip }));
      const rawData: Record<string, string> = {
        matchKey: c.reception.matchKey,
        fColumn: c.reception.fColumn,
        kColumn: c.reception.kColumn,
        lotNumber: c.reception.lotNumber ?? "",
        buildingNumber: c.reception.buildingNumber ?? "",
        ownerCount: String(c.owners.length),
        // L列(他) は補助情報として保存。物件住所や主突合キーには含めない。
        共有名義人の有無: c.reception.coOwnersNote,
        新既: c.reception.shinkiValue,
        DL: c.reception.dlMarked ? "〇" : "",
        // 所有者CSV側の DM フラグは Property.dmStatus を自動上書きしない方針。
        // ImportJobRow.rawData に集約して可視化のみ行う。
        所有者DM: ownerDmList.join(","),
        所有者CSV物件住所: ownerPropAddrList.join(" / "),
        [RECEPTION_OWNER_LINK_DATA_KEY]: JSON.stringify(ownerLinkData),
      };

      if (reason) {
        const reviewMsg = REVIEW_REASON_LABEL[reason];
        await prisma.importJobRow.create({
          data: {
            jobId: job.id,
            rowNumber,
            status: "needs_review",
            rawData: { ...rawData, ...buildErrorRawDataExtras(reviewMsg, rawData) },
            errorMessage: reviewMsg,
            createdId: null,
          },
        });
        needsReviewCount++;
        continue;
      }

      // matched && owners.length >= 1
      if (
        c.propertyMatch.status !== "matched" ||
        !c.propertyMatch.property ||
        c.owners.length === 0
      ) {
        // 安全側：想定外は skip 扱い
        const fallbackMsg = "想定外の状態";
        await prisma.importJobRow.create({
          data: {
            jobId: job.id,
            rowNumber,
            status: "needs_review",
            rawData: { ...rawData, ...buildErrorRawDataExtras(fallbackMsg, rawData) },
            errorMessage: fallbackMsg,
            createdId: null,
          },
        });
        needsReviewCount++;
        continue;
      }

      const propertyId = c.propertyMatch.property.id;

      try {
        // Property: 空欄のみ補完（既存値は保持）
        const current = existing.find((p) => p.id === propertyId);
        const updates: Record<string, string> = {};
        if (!current?.lotNumber && c.reception.lotNumber) {
          updates.lotNumber = c.reception.lotNumber;
        }
        if (!current?.buildingNumber && c.reception.buildingNumber) {
          updates.buildingNumber = c.reception.buildingNumber;
        }
        // 所有者 CSV の部屋番号でも、物件側が空のときだけ補完
        if (!current?.roomNo) {
          const firstRoom = c.owners
            .map((o) => nullIfBlank(o.roomNo))
            .find((v) => v !== null);
          if (firstRoom) {
            updates.roomNo = firstRoom;
          }
        }

        if (Object.keys(updates).length > 0) {
          const before = {
            lotNumber: current?.lotNumber ?? null,
            buildingNumber: current?.buildingNumber ?? null,
            roomNo: current?.roomNo ?? null,
          };
          await prisma.property.update({
            where: { id: propertyId },
            data: updates,
          });
          await recordChanges({
            targetTable: "properties",
            targetId: propertyId,
            changedBy: session.id,
            oldValues: before,
            newValues: { ...before, ...updates },
            trackedFields: PROPERTY_TRACKED_FIELDS,
            source: "csv_import",
          });
          propertyUpdatedCount++;
        }

        // Owner: name + address で upsert、無ければ name のみで探す
        for (const o of c.owners) {
          const ownerId = await upsertOwnerAndLink(
            propertyId,
            o,
            session.id,
            () => ownerCreatedCount++,
            () => ownerLinkedCount++,
          );
          if (!ownerId) {
            // name が無ければスキップ（owner 側要件）
            continue;
          }
        }

        await prisma.importJobRow.create({
          data: {
            jobId: job.id,
            rowNumber,
            status: "success",
            rawData,
            errorMessage: null,
            createdId: propertyId,
          },
        });
        successCount++;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "不明なエラー";
        await prisma.importJobRow.create({
          data: {
            jobId: job.id,
            rowNumber,
            status: "error",
            rawData: { ...rawData, ...buildErrorRawDataExtras(errMsg, rawData) },
            errorMessage: errMsg,
            createdId: null,
          },
        });
        errorCount++;
      }
    }

    await prisma.importJob.update({
      where: { id: job.id },
      data: {
        status: errorCount > 0 ? "failed" : "completed",
        successCount,
        errorCount: errorCount + needsReviewCount,
        completedAt: new Date(),
      },
    });

    await writeAuditLog({
      userId: session.id,
      action: "reception_owner_csv_import",
      targetTable: "import_jobs",
      targetId: job.id,
      detail: {
        receptionFileName: receptionFileName ?? null,
        ownerFileName: ownerFileName ?? null,
        summary,
        successCount,
        needsReviewCount,
        errorCount,
        propertyUpdatedCount,
        ownerCreatedCount,
        ownerLinkedCount,
      },
    });

    return apiResponse(
      {
        jobId: job.id,
        summary,
        successCount,
        needsReviewCount,
        errorCount,
        propertyUpdatedCount,
        ownerCreatedCount,
        ownerLinkedCount,
      },
      201,
    );
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- helpers ----------

async function upsertOwnerAndLink(
  propertyId: string,
  o: ParsedOwnerRow,
  userId: string,
  onOwnerCreated: () => void,
  onPropertyLinked: () => void,
): Promise<string | null> {
  const name = nullIfBlank(o.name);
  if (!name) return null; // 氏名がない行は所有者レコードを作れないのでスキップ
  const address = nullIfBlank(o.address);
  const zip = nullIfBlank(o.zip);

  // 既存 Owner 検索: name + address → name のみ
  let ownerId: string | null = null;
  let existingZip: string | null = null;
  if (address) {
    const hit = await prisma.owner.findFirst({
      where: { name, address },
      select: { id: true, zip: true },
    });
    if (hit) {
      ownerId = hit.id;
      existingZip = hit.zip;
    }
  }
  if (!ownerId) {
    const hit = await prisma.owner.findFirst({
      where: { name, address: null },
      select: { id: true, zip: true },
    });
    if (hit) {
      ownerId = hit.id;
      existingZip = hit.zip;
    }
  }

  if (!ownerId) {
    const created = await prisma.owner.create({
      data: {
        name,
        ...(address ? { address } : {}),
        ...(zip ? { zip } : {}),
      },
      select: { id: true },
    });
    ownerId = created.id;
    onOwnerCreated();
    await writeAuditLog({
      userId,
      action: "owner_created_from_reception",
      targetTable: "owners",
      targetId: ownerId,
      detail: { name, address: address ?? null, zip: zip ?? null },
    });
  } else if (zip && !existingZip) {
    // 既存所有者で郵便番号が未設定の場合のみ補完（既存値は破壊しない）
    await prisma.owner.update({
      where: { id: ownerId },
      data: { zip, version: { increment: 1 } },
    });
  }

  // PropertyOwner: 存在しなければリンク
  const existingLink = await prisma.propertyOwner.findUnique({
    where: {
      propertyId_ownerId: { propertyId, ownerId },
    },
    select: { propertyId: true },
  });
  if (!existingLink) {
    await prisma.propertyOwner.create({
      data: {
        propertyId,
        ownerId,
        relationship: "所有者",
        isPrimary: false,
      },
    });
    onPropertyLinked();
  }

  return ownerId;
}
