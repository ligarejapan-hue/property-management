import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { parseSheet, SheetParseError } from "@/lib/sheet-parser";
import { resolveImportFileType } from "@/lib/import-content-detect";
import {
  parseReceptionRows,
  applyReceptionFilters,
  DEFAULT_RECEPTION_FILTER_OPTIONS,
  type DlFilterMode,
  type ShinkiFilterMode,
} from "@/lib/reception-owner-match";
import { normalizeAddress } from "@/lib/normalize";
import {
  assertImportJsonBodySize,
  MAX_IMPORT_JSON_BODY_BYTES_PAIRED,
} from "@/lib/import-body-size";

// 受付帳CSVから物件を新規作成するプレビュー。実データは書き換えない。

function toPositionalRows(
  headers: string[],
  rows: readonly Record<string, string>[],
): string[][] {
  return rows.map((r) => headers.map((h) => r[h] ?? ""));
}

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "import", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    // body 全体をバッファする前に過大サイズを弾く(2026-08-02 監査)。
    // ⚠この経路は2ファイル(受付帳+所有者)を同時に受けるため上限は2倍(Codex #349 P2)。


    assertImportJsonBodySize(request, MAX_IMPORT_JSON_BODY_BYTES_PAIRED);


    const body = await request.json();
    const {
      receptionCsv,
      receptionXlsxBase64,
      receptionFileName,
      dlFilter,
      shinkiFilter,
    } = body as {
      receptionCsv?: string;
      receptionXlsxBase64?: string;
      receptionFileName?: string;
      dlFilter?: DlFilterMode;
      shinkiFilter?: ShinkiFilterMode;
    };
    const filterOptions = {
      dl: dlFilter ?? DEFAULT_RECEPTION_FILTER_OPTIONS.dl,
      shinki: shinkiFilter ?? DEFAULT_RECEPTION_FILTER_OPTIONS.shinki,
    };

    if (!receptionFileName) {
      throw new ApiError(422, "receptionFileName は必須です", "VALIDATION_ERROR");
    }
    if (!receptionCsv && !receptionXlsxBase64) {
      throw new ApiError(
        422,
        "csv または xlsx のいずれかを指定してください",
        "VALIDATION_ERROR",
      );
    }

    let receptionParsed: ReturnType<typeof parseSheet>;
    try {
      receptionParsed = parseSheet({
        fileName: receptionFileName,
        csvText: receptionCsv,
        xlsxBase64: receptionXlsxBase64,
      });
    } catch (e) {
      if (e instanceof SheetParseError) {
        throw new ApiError(422, e.message, e.code);
      }
      throw e;
    }
    const receptionPositional = toPositionalRows(
      receptionParsed.headers,
      receptionParsed.rows,
    );

    // ファイル種別チェック (B-11: 内容(列構成)優先・ファイル名は補助。
    // 本取込 route と同じ純関数・同じ入力で判定する)
    const receptionResolved = resolveImportFileType(
      "reception",
      receptionFileName,
      receptionParsed.headers,
      receptionPositional,
    );
    if (!receptionResolved.ok) {
      throw new ApiError(
        422,
        `受付帳ファイルとして認識できません: ${receptionResolved.error}`,
        "VALIDATION_ERROR",
      );
    }

    const allRows = applyReceptionFilters(
      parseReceptionRows(receptionPositional),
      filterOptions,
    );

    // 既存物件の住所インデックス（正規化比較用）
    const existing = await prisma.property.findMany({
      select: { id: true, address: true },
    });
    const existingNorm = new Map<string, string>();
    for (const p of existing) {
      const n = normalizeAddress(p.address);
      if (n && !existingNorm.has(n)) existingNorm.set(n, p.id);
    }

    let filteredCount = 0;
    let noAddressCount = 0;
    let duplicateCount = 0;
    let toCreateCount = 0;

    const toCreateSamples: Array<{
      rowNumber: number;
      fColumn: string;
      propertyAddress: string;
      lotNumber: string | null;
      buildingNumber: string | null;
    }> = [];
    const duplicateSamples: Array<{
      rowNumber: number;
      propertyAddress: string;
      existingPropertyId: string;
    }> = [];

    for (const row of allRows) {
      if (row.excluded) {
        filteredCount++;
        continue;
      }
      if (!row.propertyAddress) {
        noAddressCount++;
        continue;
      }
      const norm = normalizeAddress(row.propertyAddress);
      const existingId = norm ? existingNorm.get(norm) : undefined;
      if (existingId) {
        duplicateCount++;
        if (duplicateSamples.length < 5) {
          duplicateSamples.push({
            rowNumber: row.rowNumber,
            propertyAddress: row.propertyAddress,
            existingPropertyId: existingId,
          });
        }
      } else {
        toCreateCount++;
        if (toCreateSamples.length < 5) {
          toCreateSamples.push({
            rowNumber: row.rowNumber,
            fColumn: row.fColumn,
            propertyAddress: row.propertyAddress,
            lotNumber: row.lotNumber,
            buildingNumber: row.buildingNumber,
          });
          // 後続行の重複判定にも反映（同一CSVの重複防止）
          if (norm) existingNorm.set(norm, "__preview__");
        } else {
          // サンプル外でも重複判定は更新
          if (norm) existingNorm.set(norm, "__preview__");
        }
      }
    }

    return apiResponse({
      summary: {
        totalRows: allRows.length,
        filteredCount,
        noAddressCount,
        duplicateCount,
        toCreateCount,
      },
      toCreateSamples,
      duplicateSamples,
      receptionFileType: {
        type: receptionResolved.type,
        label: receptionResolved.label,
        error: null,
        warning: receptionResolved.warning,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
