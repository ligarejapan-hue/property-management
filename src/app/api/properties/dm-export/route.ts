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
import { propertyListQuerySchema } from "@/lib/validators";
import {
  buildPropertyListWhere,
  buildPropertyListOrderBy,
  loadImportSourceMap,
} from "@/lib/property-list-query";
import { encodeCsv, sanitizeCsvCellForExcel } from "@/lib/csv-encode";
import {
  DM_EXPORT_HEADERS,
  MAX_DM_EXPORT_ROWS,
  isPlainOwnerLevel,
  buildDmRow,
} from "@/lib/dm-export";

// ---------- GET /api/properties/dm-export ----------
//
// 物件一覧と同じ検索・フィルタ・sort・field_staff スコープを共有しつつ、
// サーバ側で dmStatus=send / isArchived=false を強制し、「送付可」の物件を
// 所有者 1 名 = 1 行に展開して DM 差込用 CSV を出力する。
//
// 安全上限: MAX_DM_EXPORT_ROWS 行（最終 CSV 行 = 所有者行で判定）。
// 超過時は切り捨てず 400 にする（不完全な差込 CSV を渡さない / DoS 防止）。
//
// PII / 権限:
//  - property:read / csv_export:read / csv_export_personal:read / owner:read すべて必須
//  - 加えて owner 氏名・郵便番号・住所の表示レベルが「生値を返すレベル」でなければ 403
//    （差込は生の個人情報が必須のため、マスク/部分表示では出力させない）
//  - 権限不足時は DB 取得・CSV 生成・AuditLog 書き込みを一切行わない
//  - CSV 本文・所有者名/住所/郵便番号などの PII は AuditLog に保存しない

// AuditLog の filters に残してよいキー（export route と同方針の allowlist）。
//  - mgmtId / keyword: 取込元・住所など PII を含み得るため除外
//  - page / limit    : 全件出力では無意味なため除外
//  - dmStatus        : 常に "send" を明示付与するため allowlist には含めない
const AUDIT_FILTER_KEYS = [
  "propertyType",
  "registryStatus",
  "caseStatus",
  "introductionRoute",
  "assignedTo",
  "updatedFrom",
  "updatedTo",
  "includeArchived",
  "hasWarning",
  "sortBy",
  "sortOrder",
] as const;

export async function GET(request: NextRequest) {
  try {
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    // 権限ゲート。いずれか欠ける場合はここで 403 とし、
    // DB 取得・CSV 生成・AuditLog 書き込みは一切行わない（副作用なし）。
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

    // 差込は生の氏名・郵便番号・住所が必須。これらの表示レベルが
    // 「生値を返すレベル（full / read / edit）」でなければマスクされた値しか
    // 出せないため、出力自体を 403 で拒否する。
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

    const { searchParams } = new URL(request.url);
    const queryObj: Record<string, string> = {};
    searchParams.forEach((value, key) => {
      queryObj[key] = value;
    });

    // page / limit は無視して全件出力するが、schema は共有のため parse はそのまま通す。
    const query = propertyListQuerySchema.parse(queryObj);

    // 一覧 API と同一の where / sort / field_staff スコープを共有ロジックで組み立てる。
    const { where, mgmtShortCircuitEmpty } = await buildPropertyListWhere(
      query,
      session,
    );

    // サーバ側で強制: 送付可のみ・アーカイブ除外。
    // クライアントが dmStatus=hold/no_send を渡しても無視し、send のみ出力する。
    where.dmStatus = "send";
    where.isArchived = false;

    const orderBy = buildPropertyListOrderBy(query);

    // mgmtId 検索が 0 件で短絡する場合は DB を叩かず空結果にする（export route と同方針）。
    const properties = mgmtShortCircuitEmpty
      ? []
      : await prisma.property.findMany({
          where,
          select: {
            id: true,
            address: true,
            propertyType: true,
            roomNo: true,
            propertyOwners: {
              where: { owner: { isArchived: false } },
              select: {
                isPrimary: true,
                relationship: true,
                owner: {
                  select: {
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
          orderBy,
          take: MAX_DM_EXPORT_ROWS + 1,
        });

    // 取込元（管理ID）を一括逆引き（一覧 API と共有・N+1 回避）。
    const importSourceMap = await loadImportSourceMap(
      prisma,
      properties.map((p) => p.id),
    );

    // 所有者 1 名 = 1 行に展開。非アーカイブ所有者が 0 件の物件は行を生まず skipped に数える。
    const rows: Array<Record<string, string>> = [];
    let mailablePropertyCount = 0;
    let skippedCount = 0;
    for (const p of properties) {
      if (p.propertyOwners.length === 0) {
        skippedCount += 1;
        continue;
      }
      mailablePropertyCount += 1;
      const importSourceValue = importSourceMap.get(p.id) ?? "";
      for (const po of p.propertyOwners) {
        rows.push(buildDmRow(p, po, ownerDisplayConfig, importSourceValue));
      }
    }

    // 最終 CSV 行数（所有者行）で上限判定。超過時は切り捨てず 400。AuditLog より前で throw する。
    if (rows.length > MAX_DM_EXPORT_ROWS) {
      throw new ApiError(
        400,
        "出力対象が上限（10,000件）を超えています。検索条件で絞り込んでください。",
        "EXPORT_LIMIT_EXCEEDED",
      );
    }

    // CSV formula injection 対策: 全セルを encodeCsv に渡す前に無害化する。
    const sanitizedRows = rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          sanitizeCsvCellForExcel(value),
        ]),
      ),
    );

    // UTF-8 BOM + CRLF（encodeCsv の既定挙動）で Excel 互換に出力。
    const csv = encodeCsv([...DM_EXPORT_HEADERS], sanitizedRows, { bom: true });

    // AuditLog は操作事実のみ。CSV 本文・所有者名/住所/郵便番号などの PII は残さない。
    // filters は parse 済み query からの明示 allowlist で組み、常に dmStatus:"send" を含める。
    const filtersForLog: Record<string, unknown> = { dmStatus: "send" };
    for (const key of AUDIT_FILTER_KEYS) {
      const value = query[key];
      if (value !== undefined) filtersForLog[key] = value;
    }
    await writeAuditLog({
      userId: session.id,
      action: "property_dm_csv_export",
      targetTable: "properties",
      detail: {
        filters: filtersForLog,
        count: mailablePropertyCount,
        resultCount: rows.length,
        skippedCount,
        exportedAt: new Date().toISOString(),
      },
    });

    const fileDate = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    return new NextResponse(csv, {
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
