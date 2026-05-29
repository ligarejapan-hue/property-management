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
import { hasPermission, maskValue } from "@/lib/permissions";
import { propertyListQuerySchema } from "@/lib/validators";
import {
  buildPropertyListWhere,
  buildPropertyListOrderBy,
  loadImportSourceMap,
} from "@/lib/property-list-query";
import { encodeCsv } from "@/lib/csv-encode";
import {
  PROPERTY_TYPE_LABELS,
  CASE_STATUS_LABELS,
  INTRODUCTION_ROUTE_LABELS,
  REGISTRY_STATUS_LABELS,
  DM_STATUS_LABELS,
} from "@/lib/property-types";

// ---------- GET /api/properties/export ----------
//
// 物件一覧と同じ検索・フィルタ・sort・field_staff スコープで、条件一致の「全件」を
// CSV 出力する。1ページ分ではなく全件を返す点だけが一覧 API との違い。
//
// 安全上限: MAX_EXPORT_ROWS 件。超過時は切り捨てず 400 エラーにする
//（巨大エクスポートによる DoS / メモリ枯渇防止と、不完全な CSV を渡さないため）。
//
// PII / 権限:
//  - property:read 必須
//  - field_staff は一覧と同じスコープ（自分の作成/担当のみ）
//  - 所有者名は owner:read がある場合のみ、ownerDisplayConfig / maskValue に従って出力
//  - CSV 本文・所有者名・mgmtId 生値などの PII は AuditLog に保存しない

const MAX_EXPORT_ROWS = 10000;

const CSV_HEADERS = [
  "管理ID",
  "物件種別",
  "住所",
  "地番",
  "家屋番号",
  "不動産番号",
  "登記状況",
  "DM判断",
  "案件ステータス",
  "導入ルート",
  "担当者名",
  "所有者名",
  "更新日時",
  "作成日時",
] as const;

function toCsvDateTime(value: Date | string | null | undefined): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString();
}

export async function GET(request: NextRequest) {
  try {
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "property", "read")) {
      throw new ApiError(403, "物件一覧の閲覧権限がありません", "FORBIDDEN");
    }

    const hasOwnerRead = hasPermission(permissions, "owner", "read");
    const ownerDisplayConfig = hasOwnerRead
      ? await getOwnerDisplayConfig(session.id)
      : null;

    const { searchParams } = new URL(request.url);
    const queryObj: Record<string, string> = {};
    searchParams.forEach((value, key) => {
      queryObj[key] = value;
    });

    // page / limit は無視して全件出力するが、schema は共有のため parse はそのまま通す。
    const query = propertyListQuerySchema.parse(queryObj);

    // 一覧 API と同一の where / sort / field_staff スコープを共有ロジックで組み立てる。
    const { where, mgmtShortCircuitEmpty, mgmtHitCount, mgmtIdTrimmed } =
      await buildPropertyListWhere(query, session);
    const orderBy = buildPropertyListOrderBy(query);

    // 全件取得。安全上限 +1 件まで取り、超過していれば切り捨てずエラーにする。
    const properties = mgmtShortCircuitEmpty
      ? []
      : await prisma.property.findMany({
          where,
          select: {
            id: true,
            propertyType: true,
            address: true,
            lotNumber: true,
            buildingNumber: true,
            realEstateNumber: true,
            registryStatus: true,
            dmStatus: true,
            caseStatus: true,
            introductionRoute: true,
            updatedAt: true,
            createdAt: true,
            assignee: { select: { name: true } },
            propertyOwners: {
              select: { owner: { select: { name: true } } },
              orderBy: { createdAt: "asc" },
            },
          },
          orderBy,
          take: MAX_EXPORT_ROWS + 1,
        });

    if (properties.length > MAX_EXPORT_ROWS) {
      throw new ApiError(
        400,
        `出力対象が上限（${MAX_EXPORT_ROWS.toLocaleString()}件）を超えています。検索条件で絞り込んでください。`,
        "EXPORT_LIMIT_EXCEEDED",
      );
    }

    // 取込元（管理ID）を一括逆引き（一覧 API と共有・N+1 回避）。
    const importSourceMap = await loadImportSourceMap(
      prisma,
      properties.map((p) => p.id),
    );

    const rows = properties.map((p) => {
      // 所有者名は一覧 API と同じく owner:read + ownerDisplayConfig + maskValue に従う。
      const ownerNames =
        hasOwnerRead && ownerDisplayConfig
          ? p.propertyOwners
              .map(({ owner }) => maskValue(owner.name, ownerDisplayConfig.name))
              .filter((n): n is string => n !== null)
          : [];

      return {
        管理ID: importSourceMap.get(p.id) ?? "",
        物件種別: PROPERTY_TYPE_LABELS[p.propertyType] ?? p.propertyType,
        住所: p.address ?? "",
        地番: p.lotNumber ?? "",
        家屋番号: p.buildingNumber ?? "",
        不動産番号: p.realEstateNumber ?? "",
        登記状況:
          REGISTRY_STATUS_LABELS[p.registryStatus] ?? p.registryStatus,
        DM判断: DM_STATUS_LABELS[p.dmStatus] ?? p.dmStatus,
        案件ステータス: CASE_STATUS_LABELS[p.caseStatus] ?? p.caseStatus,
        導入ルート: p.introductionRoute
          ? INTRODUCTION_ROUTE_LABELS[p.introductionRoute] ?? p.introductionRoute
          : "",
        担当者名: p.assignee?.name ?? "",
        所有者名: ownerNames.join("、"),
        更新日時: toCsvDateTime(p.updatedAt),
        作成日時: toCsvDateTime(p.createdAt),
      };
    });

    // UTF-8 BOM + CRLF（既存 encodeCsv の既定挙動）で Excel 互換に出力。
    const csv = encodeCsv([...CSV_HEADERS], rows, { bom: true });

    // AuditLog は操作事実のみ。CSV 本文・所有者名などの PII は残さない。
    //  - mgmtId : 取込元ファイル名・行番号を含む生値のため除外（長さと hit 件数のみ記録）
    //  - keyword: address / lotNumber 等を検索する語で住所等 PII を含み得るため除外
    //  - page / limit: 全件出力では無意味なページング値のため除外
    const {
      mgmtId: _omitMgmtId,
      keyword: _omitKeyword,
      page: _omitPage,
      limit: _omitLimit,
      ...filtersForLog
    } = queryObj;
    await writeAuditLog({
      userId: session.id,
      action: "property_csv_export",
      targetTable: "properties",
      detail: {
        filters: filtersForLog,
        resultCount: rows.length,
        exportedAt: new Date().toISOString(),
        ...(mgmtIdTrimmed
          ? { mgmtIdLen: mgmtIdTrimmed.length, mgmtHitCount }
          : {}),
      },
    });

    const fileDate = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="properties_${fileDate}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
