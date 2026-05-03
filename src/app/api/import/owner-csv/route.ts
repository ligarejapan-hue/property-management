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
import { parseCsv, OWNER_CSV_COLUMN_MAP } from "@/lib/csv-parser";
import { normalizeAddress } from "@/lib/address-normalizer";
import { relinkOwnersToProperties } from "@/lib/owner-property-linker";
import {
  REIMPORT_IGNORED_HEADERS,
  buildErrorRawDataExtras,
} from "@/lib/import-error-display";

// Japanese field name → Owner model property mapping
const JAPANESE_FIELD_TO_PROPERTY: Record<string, string> = {
  "氏名": "name",
  "氏名カナ": "nameKana",
  "電話番号": "phone",
  "郵便番号": "zip",
  "住所": "address",
  "備考": "note",
  "リンクキー": "externalLinkKey",
};

// ---------- POST /api/import/owner-csv ----------

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "import", "write")) {
      throw new ApiError(403, "CSV取込の権限がありません", "FORBIDDEN");
    }

    const body = await request.json();
    const { fileName, csvText, columnMapping: userColumnMapping } = body as {
      fileName?: string;
      csvText?: string;
      columnMapping?: Record<string, string>;
    };

    if (!csvText || typeof csvText !== "string") {
      throw new ApiError(422, "csvText は必須です", "VALIDATION_ERROR");
    }

    // Parse CSV
    const { headers, rows, errors: parseErrors } = parseCsv(csvText);

    if (rows.length === 0 && parseErrors.length > 0) {
      throw new ApiError(422, "CSVのパースに失敗しました", "VALIDATION_ERROR");
    }

    // Build effective column mapping: CSV header → Owner model property
    // If userColumnMapping is provided, it maps CSV header → Japanese field name
    // Then we resolve Japanese field name → model property
    // Otherwise, auto-map via OWNER_CSV_COLUMN_MAP
    const effectiveMapping: Record<string, string> = {};

    if (userColumnMapping && Object.keys(userColumnMapping).length > 0) {
      for (const [csvHeader, japaneseField] of Object.entries(userColumnMapping)) {
        // 再取込時の export-errors 固定列は完全スルー（warningも出さない）
        if (REIMPORT_IGNORED_HEADERS.has(csvHeader)) continue;
        const modelProp = JAPANESE_FIELD_TO_PROPERTY[japaneseField];
        if (modelProp) {
          effectiveMapping[csvHeader] = modelProp;
        }
      }
    } else {
      for (const h of headers) {
        if (REIMPORT_IGNORED_HEADERS.has(h)) continue;
        if (OWNER_CSV_COLUMN_MAP[h]) {
          effectiveMapping[h] = OWNER_CSV_COLUMN_MAP[h];
        }
      }
    }

    // Create import job
    const job = await prisma.importJob.create({
      data: {
        jobType: "owner_csv",
        fileName: fileName ?? "owner-import.csv",
        status: "processing",
        totalRows: rows.length,
        executedBy: session.id,
        startedAt: new Date(),
      },
    });

    let successCount = 0;
    let errorCount = 0;
    let needsReviewCount = 0;
    const createdOwnerIds: string[] = [];

    // 行ごとに「紐づけ判定に必要な元データを持っていたか」を覚えておく。
    // 行書き込みは linking 後に1回行うので、そこで status / errorMessage を最終決定する。
    const jobRows: Array<{
      jobId: string;
      rowNumber: number;
      status: "success" | "error" | "needs_review";
      rawData: Record<string, string>;
      errorMessage: string | null;
      createdId: string | null;
      hasLinkKey: boolean;
      hasAddress: boolean;
    }> = [];

    for (let i = 0; i < rows.length; i++) {
      const rawRow = rows[i];
      const rowNumber = i + 2; // 1-indexed, header is row 1

      try {
        // Map CSV columns to owner fields
        const mapped: Record<string, string> = {};
        for (const [csvCol, value] of Object.entries(rawRow)) {
          const field = effectiveMapping[csvCol];
          if (field) {
            mapped[field] = value;
          }
        }

        // Validate: name is required
        if (!mapped.name || !mapped.name.trim()) {
          jobRows.push({
            jobId: job.id,
            rowNumber,
            status: "error",
            rawData: rawRow,
            errorMessage: "氏名が空です",
            createdId: null,
            hasLinkKey: false,
            hasAddress: false,
          });
          errorCount++;
          continue;
        }

        // Duplicate check: by name + (phone or address)
        const duplicateConditions: Record<string, unknown>[] = [];
        if (mapped.phone) {
          duplicateConditions.push({ name: mapped.name, phone: mapped.phone });
        }
        if (mapped.address) {
          duplicateConditions.push({ name: mapped.name, address: mapped.address });
        }
        // If neither phone nor address, check by name only
        if (duplicateConditions.length === 0) {
          duplicateConditions.push({ name: mapped.name });
        }

        const existing = await prisma.owner.findFirst({
          where: { OR: duplicateConditions },
          select: { id: true, name: true },
        });

        if (existing) {
          jobRows.push({
            jobId: job.id,
            rowNumber,
            status: "needs_review",
            rawData: rawRow,
            errorMessage: `重複の可能性: 既存所有者ID=${existing.id} (${existing.name})`,
            createdId: null,
            hasLinkKey: !!mapped.externalLinkKey,
            hasAddress: !!mapped.address,
          });
          needsReviewCount++;
          continue;
        }

        // Build create data
        const createData: Record<string, unknown> = {
          name: mapped.name.trim(),
        };
        if (mapped.nameKana) createData.nameKana = mapped.nameKana.trim();
        if (mapped.phone) createData.phone = mapped.phone.trim();
        if (mapped.zip) createData.zip = mapped.zip.trim();
        if (mapped.address) createData.address = mapped.address.trim();
        if (mapped.note) createData.note = mapped.note.trim();
        if (mapped.externalLinkKey) createData.externalLinkKey = mapped.externalLinkKey.trim();

        const owner = await prisma.owner.create({
          data: createData as Parameters<typeof prisma.owner.create>[0]["data"],
        });

        jobRows.push({
          jobId: job.id,
          rowNumber,
          status: "success",
          rawData: rawRow,
          errorMessage: null,
          createdId: owner.id,
          hasLinkKey: !!mapped.externalLinkKey,
          hasAddress: !!mapped.address,
        });
        createdOwnerIds.push(owner.id);
        successCount++;
      } catch (err) {
        jobRows.push({
          jobId: job.id,
          rowNumber,
          status: "error",
          rawData: rawRow,
          errorMessage: err instanceof Error ? err.message : "不明なエラー",
          createdId: null,
          hasLinkKey: false,
          hasAddress: false,
        });
        errorCount++;
      }
    }
    // 行のDB書き込みは linking 完了後にまとめて行う（紐づけ結果を反映するため）。

    // Auto-link owners to properties.
    // 1) externalLinkKey 完全一致 (従来動作)
    // 2) Owner.address (正規化) と Property.address (正規化) の完全一致
    //    → 候補が 1 件に絞れる場合のみ自動リンク。複数物件にヒットする住所は
    //      安全側で自動リンクしない（手動で紐付ける運用）。
    // 既存の externalLinkKey フローを壊さず、リンクキー未設定 CSV でも
    // 物件詳細「所有者」タブに反映されるようにする最小拡張。
    let linkedCount = 0;
    let linkedByLinkKeyCount = 0;
    let linkedByAddressCount = 0;
    let addressLinkAmbiguousCount = 0;
    // 行ごとの紐づけ結果を id でひける Map にする（行書き込み時にメッセージ生成に使用）
    const linkResultByOwnerId = new Map<
      string,
      { linked: boolean; via: "linkKey" | "address" | null; ambiguous: boolean }
    >();
    for (const id of createdOwnerIds) {
      linkResultByOwnerId.set(id, { linked: false, via: null, ambiguous: false });
    }

    const linkOwnerToProperty = async (
      propertyId: string,
      ownerId: string,
    ): Promise<boolean> => {
      const existingLink = await prisma.propertyOwner.findUnique({
        where: { propertyId_ownerId: { propertyId, ownerId } },
      });
      if (existingLink) return false;
      await prisma.propertyOwner.create({
        data: {
          propertyId,
          ownerId,
          relationship: "所有者",
          isPrimary: false,
        },
      });
      return true;
    };

    if (createdOwnerIds.length > 0) {
      // (1) externalLinkKey 経由
      const ownersWithLinkKey = await prisma.owner.findMany({
        where: {
          id: { in: createdOwnerIds },
          externalLinkKey: { not: null },
        },
        select: { id: true, externalLinkKey: true },
      });

      const linkedOwnerIds = new Set<string>();
      for (const owner of ownersWithLinkKey) {
        if (!owner.externalLinkKey) continue;

        const matchingProperties = await prisma.property.findMany({
          where: { externalLinkKey: owner.externalLinkKey },
          select: { id: true },
        });

        for (const property of matchingProperties) {
          const created = await linkOwnerToProperty(property.id, owner.id);
          if (created) {
            linkedCount++;
            linkedByLinkKeyCount++;
            linkedOwnerIds.add(owner.id);
            const r = linkResultByOwnerId.get(owner.id);
            if (r) {
              r.linked = true;
              r.via = "linkKey";
            }
          }
        }
      }

      // (2) address 経由のフォールバック
      // 取込で作った Owner のうち、まだ未リンク かつ address を持つものを対象に
      // 正規化住所で Property を引く。1件に絞れる場合のみリンク。
      const addressTargets = await prisma.owner.findMany({
        where: {
          id: { in: createdOwnerIds },
          address: { not: null },
        },
        select: { id: true, address: true },
      });

      // 正規化住所 → propertyId[] を一度キャッシュする（同住所が連続する想定）。
      const propertyByNormAddr = new Map<string, string[]>();
      const ensureCandidates = async (
        normAddr: string,
        rawAddr: string,
      ): Promise<string[]> => {
        const cached = propertyByNormAddr.get(normAddr);
        if (cached) return cached;
        // DB側に正規化関数は無いので、生 address で完全一致 + contains で広めに引いて
        // アプリ側で正規化比較する。同住所表記揺れは normalizeAddress に寄せる。
        const candidates = await prisma.property.findMany({
          where: { address: { contains: rawAddr.slice(0, 8) } },
          select: { id: true, address: true },
        });
        const matched = candidates
          .filter((p) => normalizeAddress(p.address) === normAddr)
          .map((p) => p.id);
        propertyByNormAddr.set(normAddr, matched);
        return matched;
      };

      for (const owner of addressTargets) {
        if (linkedOwnerIds.has(owner.id)) continue;
        if (!owner.address) continue;
        const norm = normalizeAddress(owner.address);
        if (!norm) continue;
        const candidates = await ensureCandidates(norm, owner.address);
        if (candidates.length === 0) continue;
        if (candidates.length > 1) {
          addressLinkAmbiguousCount++;
          const r = linkResultByOwnerId.get(owner.id);
          if (r) r.ambiguous = true;
          continue; // 安全側: 自動リンクしない
        }
        const created = await linkOwnerToProperty(candidates[0], owner.id);
        if (created) {
          linkedCount++;
          linkedByAddressCount++;
          linkedOwnerIds.add(owner.id);
          const r = linkResultByOwnerId.get(owner.id);
          if (r) {
            r.linked = true;
            r.via = "address";
          }
        }
      }
    }

    // (3) 既存未リンク Owner の救済パス。
    // 過去に取込済みだが PropertyOwner を 1 件も持たない Owner を、
    // 上記 (1)(2) と同じロジックで自動リンクする。重複検出で needs_review に
    // なって createdOwnerIds に入らなかったケースもここで救われる。
    let rescuedLinkedCount = 0;
    let rescuedLinkedByLinkKeyCount = 0;
    let rescuedLinkedByAddressCount = 0;
    let rescuedAddressLinkAmbiguousCount = 0;
    let rescueCandidateCount = 0;
    try {
      const rescue = await relinkOwnersToProperties();
      rescuedLinkedCount = rescue.linkedCount;
      rescuedLinkedByLinkKeyCount = rescue.linkedByLinkKeyCount;
      rescuedLinkedByAddressCount = rescue.linkedByAddressCount;
      rescuedAddressLinkAmbiguousCount = rescue.addressLinkAmbiguousCount;
      rescueCandidateCount = rescue.candidateOwnerCount;
      linkedCount += rescue.linkedCount;
      linkedByLinkKeyCount += rescue.linkedByLinkKeyCount;
      linkedByAddressCount += rescue.linkedByAddressCount;
      addressLinkAmbiguousCount += rescue.addressLinkAmbiguousCount;
    } catch {
      // 救済処理は best-effort: 失敗しても本体の取込結果は返す
    }

    // === 行ごとに紐づけ結果を反映してから DB に書き込む ===
    // - 紐づけ成功 → status=success のまま、errorMessage に「紐づけ完了[...]」を残す
    // - 紐づけ不可 → status=needs_review に降格、errorMessage に理由を残す
    // 紐づけ判定材料が CSV に無かった行（リンクキー・住所どちらも未指定）も
    // 黙って成功にせず needs_review に落として利用者にレビューを促す。
    let linkSuccessRowCount = 0;
    let linkFailedRowCount = 0;
    for (const row of jobRows) {
      if (row.status === "success" && row.createdId) {
        const r = linkResultByOwnerId.get(row.createdId);
        if (r?.linked) {
          row.errorMessage =
            r.via === "linkKey"
              ? "紐づけ完了[リンクキー一致]"
              : "紐づけ完了[住所一致（正規化比較）]";
          linkSuccessRowCount++;
        } else {
          // 降格: success → needs_review
          if (r?.ambiguous) {
            row.errorMessage =
              "紐づけ不可: 同一住所に複数物件が存在するため要手動紐づけ";
          } else if (row.hasLinkKey) {
            row.errorMessage =
              "紐づけ不可: リンクキーに一致する物件がありません";
          } else if (row.hasAddress) {
            row.errorMessage =
              "紐づけ不可: 住所に一致する物件がありません";
          } else {
            row.errorMessage =
              "紐づけ不可: 物件特定キー（リンクキー/住所）が指定されていません";
          }
          row.status = "needs_review";
          successCount--;
          needsReviewCount++;
          linkFailedRowCount++;
        }
      }
    }

    // Save job rows
    for (const row of jobRows) {
      const enrichedRawData =
        row.status === "error" || row.status === "needs_review"
          ? {
              ...(row.rawData as Record<string, unknown>),
              ...buildErrorRawDataExtras(row.errorMessage, row.rawData),
            }
          : row.rawData;
      await prisma.importJobRow.create({
        data: {
          jobId: row.jobId,
          rowNumber: row.rowNumber,
          status: row.status,
          rawData: enrichedRawData,
          errorMessage: row.errorMessage,
          createdId: row.createdId,
        },
      });
    }

    // Finalize job
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
      action: "owner_csv_import",
      targetTable: "import_jobs",
      targetId: job.id,
      detail: {
        fileName: fileName ?? "owner-import.csv",
        totalRows: rows.length,
        successCount,
        errorCount,
        needsReviewCount,
        linkedByLinkKeyCount,
        linkedByAddressCount,
        addressLinkAmbiguousCount,
        linkedCount,
        linkSuccessRowCount,
        linkFailedRowCount,
        rescueCandidateCount,
        rescuedLinkedCount,
        rescuedLinkedByLinkKeyCount,
        rescuedLinkedByAddressCount,
        rescuedAddressLinkAmbiguousCount,
      },
    });

    return apiResponse(
      {
        jobId: job.id,
        totalRows: rows.length,
        successCount,
        errorCount,
        needsReviewCount,
        linkedCount,
        linkedByLinkKeyCount,
        linkedByAddressCount,
        addressLinkAmbiguousCount,
        linkSuccessRowCount,
        linkFailedRowCount,
        rescueCandidateCount,
        rescuedLinkedCount,
        rescuedLinkedByLinkKeyCount,
        rescuedLinkedByAddressCount,
        rescuedAddressLinkAmbiguousCount,
      },
      201,
    );
  } catch (error) {
    return handleApiError(error);
  }
}
