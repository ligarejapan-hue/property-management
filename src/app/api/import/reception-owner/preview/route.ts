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
  parseOwnerRows,
  OWNER_SHEET_POSTAL_HEADERS,
  buildCombinedMatches,
  summarizeMatches,
  getReviewReason,
  applyReceptionFilters,
  DEFAULT_RECEPTION_FILTER_OPTIONS,
  REVIEW_REASON_LABEL,
  type PropertyCandidate,
  type DlFilterMode,
  type ShinkiFilterMode,
} from "@/lib/reception-owner-match";
import {
  assertImportJsonBodySize,
  MAX_IMPORT_JSON_BODY_BYTES_PAIRED,
} from "@/lib/import-body-size";

// 受付帳CSV × 所有者CSV × 既存物件 の突合プレビュー。
// 実データは書き換えない。

// ---------- helpers ----------

function toPositionalRows(
  headers: string[],
  rows: readonly Record<string, string>[],
): string[][] {
  return rows.map((r) => headers.map((h) => r[h] ?? ""));
}

// ---------- POST ----------

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
        // ⚠郵便番号の先頭0を落とさない（Excel は 0100492 を数値 100492 として読む）。
        formattedTextHeaders: OWNER_SHEET_POSTAL_HEADERS,
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
    const ownerPositional = toPositionalRows(
      ownerParsed.headers,
      ownerParsed.rows,
    );

    // ファイル種別チェック (B-11: 内容(列構成)を優先し、ファイル名は補助シグナル。
    // 取り違え(中身がもう一方の形式)のみ 422。本取込 route と同じ純関数を同じ
    // 入力で使い、プレビュー通過 = 実行も通過を保証する)
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
    const ownerResolved = resolveImportFileType(
      "owner",
      ownerFileName,
      ownerParsed.headers,
      ownerPositional,
    );
    if (!ownerResolved.ok) {
      throw new ApiError(
        422,
        `所有者ファイルとして認識できません: ${ownerResolved.error}`,
        "VALIDATION_ERROR",
      );
    }

    const receptionRows = applyReceptionFilters(
      parseReceptionRows(receptionPositional),
      filterOptions,
    );
    const ownerRows = parseOwnerRows(ownerParsed.headers, ownerPositional);

    // 既存物件の候補
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

    // 突合
    const combined = buildCombinedMatches(receptionRows, ownerRows, candidates);
    const summary = summarizeMatches(receptionRows, ownerRows.length, combined);

    // サンプル行（最大 20 件 / カテゴリ）
    const MAX_SAMPLE = 20;
    const matchedSamples: Array<{
      rowNumber: number;
      matchKey: string;
      propertyId: string;
      propertyAddress: string;
      ownerCount: number;
      ownerNames: string[];
    }> = [];
    const reviewSamples: Array<{
      rowNumber: number;
      matchKey: string;
      fColumn: string;
      kColumn: string;
      reason: string;
      reasonLabel: string;
      candidateCount: number;
      ownerCount: number;
      propertyStatus: "matched" | "not_found" | "multiple" | "no_key";
      /** matched 物件があれば物件詳細へ飛べるよう ID を渡す（owner_unmatched 等で使用）。 */
      propertyId: string | null;
      /** multiple 候補のときに直接遷移できる候補物件 ID（最大10件まで）。 */
      candidatePropertyIds: string[];
      /** 受付帳から拾った地番（K列の正規化結果）。 */
      lotNumber: string | null;
      /** 受付帳から拾った家屋番号（K列の正規化結果）。 */
      buildingNumber: string | null;
    }> = [];

    for (const c of combined) {
      const reason = getReviewReason(c);
      if (!reason && c.propertyMatch.status === "matched" && c.propertyMatch.property) {
        if (matchedSamples.length < MAX_SAMPLE) {
          matchedSamples.push({
            rowNumber: c.reception.rowNumber,
            matchKey: c.reception.matchKey,
            propertyId: c.propertyMatch.property.id,
            propertyAddress: c.propertyMatch.property.address,
            ownerCount: c.owners.length,
            ownerNames: c.owners.map((o) => o.name ?? "").filter((x) => x),
          });
        }
      } else if (reason) {
        if (reviewSamples.length < MAX_SAMPLE) {
          const matchedId =
            c.propertyMatch.status === "matched"
              ? c.propertyMatch.property?.id ?? null
              : null;
          const candidates =
            c.propertyMatch.status === "multiple"
              ? c.propertyMatch.candidates ?? []
              : [];
          reviewSamples.push({
            rowNumber: c.reception.rowNumber,
            matchKey: c.reception.matchKey,
            fColumn: c.reception.fColumn,
            kColumn: c.reception.kColumn,
            reason,
            reasonLabel: REVIEW_REASON_LABEL[reason],
            candidateCount: candidates.length,
            ownerCount: c.owners.length,
            propertyStatus: c.propertyMatch.status,
            propertyId: matchedId,
            candidatePropertyIds: candidates.slice(0, 10).map((p) => p.id),
            lotNumber: c.reception.lotNumber,
            buildingNumber: c.reception.buildingNumber,
          });
        }
      }
    }

    return apiResponse({
      summary,
      matchedSamples,
      reviewSamples,
      receptionFileType: {
        type: receptionResolved.type,
        label: receptionResolved.label,
        error: null,
        warning: receptionResolved.warning,
      },
      ownerFileType: {
        type: ownerResolved.type,
        label: ownerResolved.label,
        error: null,
        warning: ownerResolved.warning,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
