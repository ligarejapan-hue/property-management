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
import { PROPERTY_CSV_COLUMN_MAP } from "@/lib/csv-parser";
import { parseSheet, SheetParseError } from "@/lib/sheet-parser";
import { recordChanges, PROPERTY_TRACKED_FIELDS } from "@/lib/change-log";
import {
  PROPERTY_TYPE_VALUES,
  PROPERTY_TYPE_JP_TO_VALUE,
  CASE_STATUS_VALUES,
  normalizeCaseStatusInput,
  normalizeIntroductionRouteInput,
} from "@/lib/property-types";
import {
  buildDedupeIndex,
  addToDedupeIndex,
  findPropertyDuplicate,
  findBuildingByNormalizedName,
  isUpdateEligibleReason,
  UPDATABLE_PROPERTY_FIELDS,
  type UpdatablePropertyField,
} from "@/lib/import-dedupe";
import { normalizeBuildingName } from "@/lib/normalize";
import {
  REIMPORT_IGNORED_HEADERS,
  buildErrorRawDataExtras,
} from "@/lib/import-error-display";

const VALID_PROPERTY_TYPES: readonly string[] = PROPERTY_TYPE_VALUES;
const VALID_REGISTRY_STATUS = ["unconfirmed", "scheduled", "obtained"];
const VALID_DM_STATUS = ["send", "hold", "no_send"];
const VALID_OCCUPANCY_STATUS = ["vacant", "occupied", "unknown"];

/** Map Japanese target field names to property field names. */
const JAPANESE_FIELD_MAP: Record<string, string> = {
  "住所": "address",
  "地番": "lotNumber",
  "家屋番号": "buildingNumber",
  "不動産番号": "realEstateNumber",
  "種別": "propertyType",
  "登記状況": "registryStatus",
  "DM判断": "dmStatus",
  "案件ステータス": "caseStatus",
  "導入ルート": "introductionRoute",
  "流入経路": "introductionRoute",
  "獲得経路": "introductionRoute",
  "用途地域": "zoningDistrict",
  "路線価": "rosenkaValue",
  "緯度": "gpsLat",
  "経度": "gpsLng",
  "備考": "note",
  "リンクキー": "externalLinkKey",
  // Unit-specific
  "棟名": "buildingName",
  "マンション名": "buildingName",
  "部屋番号": "roomNo",
  "号室": "roomNo",
  "階": "floorNo",
  "階数": "floorNo",
  "専有面積": "exclusiveArea",
  "バルコニー面積": "balconyArea",
  "間取り": "layoutType",
  "向き": "orientation",
  "管理費": "managementFee",
  "修繕積立金": "repairReserveFee",
  "入居状況": "occupancyStatus",
  "持分備考": "ownershipShareNote",
};

/** When building is not found for a unit import, behaviour config. */
const UNIT_BUILDING_NOT_FOUND =
  (process.env.UNIT_IMPORT_BUILDING_NOT_FOUND as
    | "needs_review"
    | "auto_create"
    | undefined) ?? "needs_review";

// ---------------------------------------------------------------------------
// Building name lookup cache (per-request)
// ---------------------------------------------------------------------------

type BuildingLookupCache = Map<string, string | null>;

/**
 * Resolve buildingName to buildingId.
 * Strategy: exact match on name, then name + address prefix.
 * Caches results for the duration of a single import.
 */
interface BuildingCandidate {
  id: string;
  name: string;
  address: string;
}

interface BuildingResolution {
  buildingId: string | null;
  autoCreated: boolean;
  error?: string;
  candidates?: BuildingCandidate[];
}

async function resolveBuildingId(
  buildingName: string,
  address: string | undefined,
  sessionUserId: string,
  cache: BuildingLookupCache,
): Promise<BuildingResolution> {
  const cacheKey = `${buildingName}|||${address ?? ""}`;
  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey)!;
    return { buildingId: cached, autoCreated: false };
  }

  // 1. Try exact name match
  let candidates = await prisma.building.findMany({
    where: { name: buildingName },
    select: { id: true, name: true, address: true },
    take: 10,
  });

  // 1b. If raw exact miss, try normalized-name match (全角半角・空白・大小文字ゆれ吸収)
  if (candidates.length === 0) {
    const normTarget = normalizeBuildingName(buildingName);
    if (normTarget) {
      const pool = await prisma.building.findMany({
        select: { id: true, name: true, address: true },
        take: 2000,
      });
      const hit = findBuildingByNormalizedName(pool, buildingName);
      if (hit) {
        cache.set(cacheKey, hit.id);
        return { buildingId: hit.id, autoCreated: false };
      }
      // Promote normalized-equal pool members as candidates so address narrowing can run next
      candidates = pool.filter(
        (b) => normalizeBuildingName(b.name) === normTarget,
      );
    }
  }

  if (candidates.length === 1) {
    cache.set(cacheKey, candidates[0].id);
    return { buildingId: candidates[0].id, autoCreated: false };
  }

  // 2. If multiple matches, narrow by address prefix
  if (candidates.length > 1 && address) {
    // Try progressively shorter prefixes: 10 → 8 → 6 chars
    for (const prefixLen of [10, 8, 6]) {
      if (address.length >= prefixLen) {
        const prefix = address.slice(0, prefixLen);
        const narrowed = candidates.filter((c) => c.address.startsWith(prefix));
        if (narrowed.length === 1) {
          cache.set(cacheKey, narrowed[0].id);
          return { buildingId: narrowed[0].id, autoCreated: false };
        }
      }
    }
  }

  // 3. If no exact match, try partial name match (contains)
  if (candidates.length === 0) {
    const partialCandidates = await prisma.building.findMany({
      where: {
        OR: [
          { name: { contains: buildingName } },
          { name: { startsWith: buildingName.slice(0, Math.max(3, Math.floor(buildingName.length * 0.7))) } },
        ],
      },
      select: { id: true, name: true, address: true },
      take: 5,
    });

    if (partialCandidates.length === 1) {
      cache.set(cacheKey, partialCandidates[0].id);
      return { buildingId: partialCandidates[0].id, autoCreated: false };
    }

    // Return partial matches as candidates for user selection
    if (partialCandidates.length > 1) {
      cache.set(cacheKey, null);
      return {
        buildingId: null,
        autoCreated: false,
        error: `棟名「${buildingName}」に類似する棟が${partialCandidates.length}件見つかりました。レビュー画面で選択してください`,
        candidates: partialCandidates,
      };
    }
  }

  // 4. Not found: auto-create or needs_review depending on config
  if (candidates.length === 0 && UNIT_BUILDING_NOT_FOUND === "auto_create" && address) {
    const newBuilding = await prisma.building.create({
      data: {
        name: buildingName,
        address: address,
        createdBy: sessionUserId,
      },
    });
    cache.set(cacheKey, newBuilding.id);
    return { buildingId: newBuilding.id, autoCreated: true };
  }

  cache.set(cacheKey, null);

  if (candidates.length > 1) {
    return {
      buildingId: null,
      autoCreated: false,
      error: `棟名「${buildingName}」に一致する棟が${candidates.length}件あり特定できません。レビュー画面で選択してください`,
      candidates,
    };
  }

  return {
    buildingId: null,
    autoCreated: false,
    error: `棟名「${buildingName}」が見つかりません。棟を先に登録するか、レビュー画面で対応してください`,
  };
}

// ---------- POST /api/import/csv ----------
// Accepts raw CSV text in request body (Content-Type: text/csv or multipart).
// For simplicity in Phase 3, accepts JSON { fileName, csvText }.

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "import", "write")) {
      throw new ApiError(403, "CSV取込の権限がありません", "FORBIDDEN");
    }

    const body = await request.json();
    const { fileName, csvText, xlsxBase64, columnMapping } = body as {
      fileName?: string;
      csvText?: string;
      xlsxBase64?: string;
      columnMapping?: Record<string, string>;
    };

    if (!fileName) {
      throw new ApiError(422, "fileName は必須です", "VALIDATION_ERROR");
    }
    if (!csvText && !xlsxBase64) {
      throw new ApiError(422, "csvText または xlsxBase64 は必須です", "VALIDATION_ERROR");
    }

    // Parse CSV or XLSX (unified)
    let headers: string[];
    let rows: Record<string, string>[];
    let parseErrors: Array<{ row: number; message: string }>;
    try {
      const parsed = parseSheet({ fileName, csvText, xlsxBase64 });
      headers = parsed.headers;
      rows = parsed.rows;
      parseErrors = parsed.errors;
    } catch (e) {
      if (e instanceof SheetParseError) {
        throw new ApiError(422, e.message, e.code);
      }
      throw e;
    }

    if (rows.length === 0 && parseErrors.length > 0) {
      throw new ApiError(422, "ファイルのパースに失敗しました", "VALIDATION_ERROR");
    }

    // Build a lookup: csvHeader → property field name.
    // When columnMapping is provided (keys = CSV headers, values = Japanese field names),
    // convert Japanese names to property field names via JAPANESE_FIELD_MAP.
    // Otherwise fall back to auto-mapping via PROPERTY_CSV_COLUMN_MAP.
    const headerToField: Record<string, string> = {};
    if (columnMapping && Object.keys(columnMapping).length > 0) {
      for (const [csvHeader, japaneseName] of Object.entries(columnMapping)) {
        // 再取込時に export-errors の固定列が混ざっていても完全に無視する
        // （warning も出さない）。__error_field 等は __ プレフィックスなので
        // 既存の rawData ループで自然に除外されるため別途対処不要。
        if (REIMPORT_IGNORED_HEADERS.has(csvHeader)) continue;
        const field = JAPANESE_FIELD_MAP[japaneseName];
        if (field) {
          headerToField[csvHeader] = field;
        }
      }
    } else {
      for (const h of headers) {
        if (REIMPORT_IGNORED_HEADERS.has(h)) continue;
        if (PROPERTY_CSV_COLUMN_MAP[h]) {
          headerToField[h] = PROPERTY_CSV_COLUMN_MAP[h];
        }
      }
    }

    // Check that address field is mapped
    const hasAddressMapping = Object.values(headerToField).includes("address");
    if (!hasAddressMapping) {
      throw new ApiError(
        422,
        "必須カラム「住所」(address)がCSVヘッダーに見つかりません",
        "VALIDATION_ERROR",
      );
    }

    // Create import job
    const job = await prisma.importJob.create({
      data: {
        jobType: "property_csv",
        fileName: fileName ?? "import.csv",
        status: "processing",
        totalRows: rows.length,
        executedBy: session.id,
        startedAt: new Date(),
      },
    });

    let successCount = 0;
    let updateCount = 0;
    let errorCount = 0;
    const jobRows: Array<{
      jobId: string;
      rowNumber: number;
      status: "success" | "error" | "needs_review";
      rawData: Record<string, string>;
      errorMessage: string | null;
      createdId: string | null;
    }> = [];

    // Building name lookup cache for unit imports
    const buildingCache: BuildingLookupCache = new Map();

    // Build normalized dedupe index once (address / unit roomNo / identifier fallback)
    const existingPropsForDedupe = await prisma.property.findMany({
      select: {
        id: true,
        address: true,
        roomNo: true,
        buildingId: true,
        realEstateNumber: true,
        externalLinkKey: true,
      },
    });
    const dedupeIndex = buildDedupeIndex(existingPropsForDedupe);

    for (let i = 0; i < rows.length; i++) {
      const rawRow = rows[i];
      const rowNumber = i + 2; // 1-indexed, header is row 1

      try {
        // Map CSV columns to property fields
        const mapped: Record<string, string> = {};
        for (const [csvCol, value] of Object.entries(rawRow)) {
          const field = headerToField[csvCol];
          if (field) {
            mapped[field] = value;
          }
        }

        // Validate required field
        if (!mapped.address) {
          jobRows.push({
            jobId: job.id,
            rowNumber,
            status: "error",
            rawData: rawRow,
            errorMessage: "住所が空です",
            createdId: null,
          });
          errorCount++;
          continue;
        }

        // Validate / normalize propertyType
        // 1. 日本語ラベルを enum 値に変換（例: "土地" → "land"）
        // 2. 不明な値は "unknown" にフォールバック
        if (mapped.propertyType) {
          const jpMapped = PROPERTY_TYPE_JP_TO_VALUE[mapped.propertyType];
          if (jpMapped) {
            mapped.propertyType = jpMapped;
          } else if (!VALID_PROPERTY_TYPES.includes(mapped.propertyType)) {
            mapped.propertyType = "unknown";
          }
        }
        if (
          mapped.registryStatus &&
          !VALID_REGISTRY_STATUS.includes(mapped.registryStatus)
        ) {
          delete mapped.registryStatus;
        }
        if (mapped.dmStatus && !VALID_DM_STATUS.includes(mapped.dmStatus)) {
          delete mapped.dmStatus;
        }
        if (mapped.caseStatus) {
          const normalized = normalizeCaseStatusInput(mapped.caseStatus);
          if (normalized) {
            mapped.caseStatus = normalized;
          } else {
            delete mapped.caseStatus;
          }
        }
        if (mapped.introductionRoute) {
          const normalized = normalizeIntroductionRouteInput(mapped.introductionRoute);
          if (normalized) {
            mapped.introductionRoute = normalized;
          } else {
            delete mapped.introductionRoute;
          }
        }
        if (
          mapped.occupancyStatus &&
          !VALID_OCCUPANCY_STATUS.includes(mapped.occupancyStatus)
        ) {
          delete mapped.occupancyStatus;
        }

        // -----------------------------------------------------------
        // Unit / building name resolution
        // -----------------------------------------------------------
        // 旧値 "unit" / 新値 "apartment_unit" / buildingName あり をすべて区分扱い
        const isUnit =
          mapped.propertyType === "apartment_unit" ||
          mapped.propertyType === "unit" ||
          !!mapped.buildingName;
        let resolvedBuildingId: string | null = null;

        if (isUnit && mapped.buildingName) {
          // 新規取込は正式値 apartment_unit に統一（旧 unit は出力しない）
          mapped.propertyType = "apartment_unit";

          const resolution = await resolveBuildingId(
            mapped.buildingName.trim(),
            mapped.address,
            session.id,
            buildingCache,
          );

          if (!resolution.buildingId) {
            // Building not found → needs_review
            // Include candidates in rawData for review UI
            const enrichedRawRow = { ...rawRow };
            if (resolution.candidates && resolution.candidates.length > 0) {
              enrichedRawRow["__building_candidates"] = JSON.stringify(
                resolution.candidates.map((c) => ({
                  id: c.id,
                  name: c.name,
                  address: c.address,
                })),
              );
            }
            jobRows.push({
              jobId: job.id,
              rowNumber,
              status: "needs_review",
              rawData: enrichedRawRow,
              errorMessage: resolution.error ?? "棟名が見つかりません。棟を先に登録してください",
              createdId: null,
            });
            continue;
          }
          resolvedBuildingId = resolution.buildingId;
        }

        // -----------------------------------------------------------
        // Duplicate check (比較用値ベース / 正規化比較)
        // -----------------------------------------------------------
        const dupHit = findPropertyDuplicate(
          dedupeIndex,
          {
            address: mapped.address,
            roomNo: mapped.roomNo,
            buildingId: resolvedBuildingId,
            realEstateNumber: mapped.realEstateNumber,
            externalLinkKey: mapped.externalLinkKey,
          },
          existingPropsForDedupe,
        );

        if (dupHit) {
          // 住所のみ一致など取り違えリスクのある理由はレビューへ
          if (!isUpdateEligibleReason(dupHit.reason)) {
            jobRows.push({
              jobId: job.id,
              rowNumber,
              status: "needs_review",
              rawData: rawRow,
              errorMessage: `重複の可能性[${dupHit.reason}]: 既存物件ID=${dupHit.matchedId} (${dupHit.matchedAddress})`,
              createdId: null,
            });
            continue;
          }

          // UPDATABLE_PROPERTY_FIELDS ∩ (CSV に非空で入っている項目) のみ更新
          // 空の値でマスター側を潰さないよう、空・undefined は含めない
          const updateData: Record<string, unknown> = {};
          const numericFields = new Set<UpdatablePropertyField>([
            "rosenkaValue",
            "gpsLat",
            "gpsLng",
            "exclusiveArea",
            "balconyArea",
          ]);
          const intFields = new Set<UpdatablePropertyField>([
            "floorNo",
            "managementFee",
            "repairReserveFee",
          ]);
          const trimFields = new Set<UpdatablePropertyField>([
            "layoutType",
            "orientation",
          ]);

          for (const field of UPDATABLE_PROPERTY_FIELDS) {
            const raw = mapped[field];
            if (raw === undefined || raw === null || raw === "") continue;
            if (numericFields.has(field)) {
              const n = parseFloat(raw);
              if (!Number.isNaN(n)) updateData[field] = n;
            } else if (intFields.has(field)) {
              const n = parseInt(raw);
              if (!Number.isNaN(n)) updateData[field] = n;
            } else if (trimFields.has(field)) {
              const v = raw.trim();
              if (v) updateData[field] = v;
            } else {
              updateData[field] = raw;
            }
          }

          // 実際に値が変わる項目だけに絞る
          const existing = await prisma.property.findUnique({
            where: { id: dupHit.matchedId },
          });
          const changedFields: string[] = [];
          const finalUpdateData: Record<string, unknown> = {};
          if (existing) {
            for (const [k, v] of Object.entries(updateData)) {
              const prev = (existing as unknown as Record<string, unknown>)[k];
              const prevStr = prev == null ? null : String(prev);
              const nextStr = v == null ? null : String(v);
              if (prevStr !== nextStr) {
                finalUpdateData[k] = v;
                changedFields.push(k);
              }
            }
          }

          if (!existing || changedFields.length === 0) {
            // 既存値と完全一致 → 変更なし。success 扱いで「更新なし」を伝える
            jobRows.push({
              jobId: job.id,
              rowNumber,
              status: "success",
              rawData: rawRow,
              errorMessage: `更新[${dupHit.reason}]: 既存物件ID=${dupHit.matchedId} (更新項目: なし)`,
              createdId: dupHit.matchedId,
            });
            updateCount++;
            successCount++;
            continue;
          }

          const updated = await prisma.property.update({
            where: { id: dupHit.matchedId },
            data: finalUpdateData as Parameters<
              typeof prisma.property.update
            >[0]["data"],
          });

          await recordChanges({
            targetTable: "properties",
            targetId: updated.id,
            changedBy: session.id,
            oldValues: existing as unknown as Record<string, unknown>,
            newValues: finalUpdateData,
            trackedFields: PROPERTY_TRACKED_FIELDS,
            source: "csv_import",
          });

          // dedupe index も住所変更などに備えて反映
          const updatedRecord = {
            id: updated.id,
            address: updated.address,
            roomNo: updated.roomNo ?? null,
            buildingId: updated.buildingId ?? null,
            realEstateNumber: updated.realEstateNumber ?? null,
            externalLinkKey: updated.externalLinkKey ?? null,
          };
          addToDedupeIndex(dedupeIndex, updatedRecord);
          const idxInAll = existingPropsForDedupe.findIndex(
            (p) => p.id === updated.id,
          );
          if (idxInAll >= 0) existingPropsForDedupe[idxInAll] = updatedRecord;

          jobRows.push({
            jobId: job.id,
            rowNumber,
            status: "success",
            rawData: rawRow,
            errorMessage: `更新[${dupHit.reason}]: 既存物件ID=${updated.id} (更新項目: ${changedFields.join(", ")})`,
            createdId: updated.id,
          });
          updateCount++;
          successCount++;
          continue;
        }

        // -----------------------------------------------------------
        // Build create data
        // -----------------------------------------------------------
        const createData: Record<string, unknown> = {
          address: mapped.address,
          propertyType: mapped.propertyType || "unknown",
          registryStatus: mapped.registryStatus || "unconfirmed",
          dmStatus: mapped.dmStatus || "hold",
          caseStatus: mapped.caseStatus || "new_case",
          createdBy: session.id,
        };

        // Standard fields
        if (mapped.lotNumber) createData.lotNumber = mapped.lotNumber;
        if (mapped.buildingNumber)
          createData.buildingNumber = mapped.buildingNumber;
        if (mapped.realEstateNumber)
          createData.realEstateNumber = mapped.realEstateNumber;
        if (mapped.externalLinkKey)
          createData.externalLinkKey = mapped.externalLinkKey;
        if (mapped.zoningDistrict)
          createData.zoningDistrict = mapped.zoningDistrict;
        if (mapped.rosenkaValue)
          createData.rosenkaValue = parseFloat(mapped.rosenkaValue) || null;
        if (mapped.gpsLat)
          createData.gpsLat = parseFloat(mapped.gpsLat) || null;
        if (mapped.gpsLng)
          createData.gpsLng = parseFloat(mapped.gpsLng) || null;
        if (mapped.note) createData.note = mapped.note;
        if (mapped.introductionRoute) createData.introductionRoute = mapped.introductionRoute;

        // Unit-specific fields
        if (resolvedBuildingId) createData.buildingId = resolvedBuildingId;
        if (mapped.roomNo) createData.roomNo = mapped.roomNo.trim();
        if (mapped.floorNo) {
          const n = parseInt(mapped.floorNo);
          if (!isNaN(n)) createData.floorNo = n;
        }
        if (mapped.exclusiveArea) {
          const n = parseFloat(mapped.exclusiveArea);
          if (!isNaN(n)) createData.exclusiveArea = n;
        }
        if (mapped.balconyArea) {
          const n = parseFloat(mapped.balconyArea);
          if (!isNaN(n)) createData.balconyArea = n;
        }
        if (mapped.layoutType) createData.layoutType = mapped.layoutType.trim();
        if (mapped.orientation) createData.orientation = mapped.orientation.trim();
        if (mapped.managementFee) {
          const n = parseInt(mapped.managementFee);
          if (!isNaN(n)) createData.managementFee = n;
        }
        if (mapped.repairReserveFee) {
          const n = parseInt(mapped.repairReserveFee);
          if (!isNaN(n)) createData.repairReserveFee = n;
        }
        if (mapped.occupancyStatus)
          createData.occupancyStatus = mapped.occupancyStatus;
        if (mapped.ownershipShareNote)
          createData.ownershipShareNote = mapped.ownershipShareNote;

        const property = await prisma.property.create({
          data: createData as Parameters<typeof prisma.property.create>[0]["data"],
        });

        // Reflect newly-created row into dedupe index so later CSV rows catch it
        const newRecord = {
          id: property.id,
          address: property.address,
          roomNo: property.roomNo ?? null,
          buildingId: property.buildingId ?? null,
          realEstateNumber: property.realEstateNumber ?? null,
          externalLinkKey: property.externalLinkKey ?? null,
        };
        addToDedupeIndex(dedupeIndex, newRecord);
        existingPropsForDedupe.push(newRecord);

        jobRows.push({
          jobId: job.id,
          rowNumber,
          status: "success",
          rawData: rawRow,
          errorMessage: null,
          createdId: property.id,
        });
        successCount++;
      } catch (err) {
        jobRows.push({
          jobId: job.id,
          rowNumber,
          status: "error",
          rawData: rawRow,
          errorMessage:
            err instanceof Error ? err.message : "不明なエラー",
          createdId: null,
        });
        errorCount++;
      }
    }

    // Save job rows
    for (const row of jobRows) {
      // error / needs_review 行のみ rawData にエラー構造化キー
      // (__error_field / __error_code) を追記する。success 行は不要。
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
    const needsReviewCount = jobRows.filter(
      (r) => r.status === "needs_review",
    ).length;

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
      action: "csv_import",
      targetTable: "import_jobs",
      targetId: job.id,
      detail: {
        fileName: fileName ?? "import.csv",
        totalRows: rows.length,
        successCount,
        updateCount,
        errorCount,
        needsReviewCount,
      },
    });

    return apiResponse(
      {
        jobId: job.id,
        totalRows: rows.length,
        successCount,
        updateCount,
        errorCount,
        needsReviewCount,
        parseErrors,
      },
      201,
    );
  } catch (error) {
    return handleApiError(error);
  }
}
