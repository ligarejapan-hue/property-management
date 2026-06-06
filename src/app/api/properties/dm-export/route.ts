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
// 「最終 owner 行数が上限超なら必ず 400 / 部分 CSV の 200 を返さない」は
// 事前 COUNT + 所有者あり物件のみ取得 + 取得後再判定 の 3 層で保証する（GET 内コメント参照）。
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

    // 上限判定は「最終 CSV 行数 = 所有者行数」で行う。property 件数を take で切ると、
    // ownerなし物件が窓を消費して後続の eligible owner 行が欠落した 200（不完全 CSV）に
    // なり得るため、次の 3 層で「owner 行数が上限超なら確実に 400」を保証する:
    //  (1) fetch 前に owner 行数を COUNT し、超過なら PII を一切取得せず 400
    //  (2) fetch 対象を「非アーカイブ所有者が 1 名以上の物件」に限定し、
    //      ownerなし物件が take 窓を消費しないようにする（行の完全性の核）
    //  (3) COUNT と fetch の間の更新（race）に備え、取得後の行数でも再判定して 400
    const eligibleOwnerWhere = { owner: { isArchived: false } };

    // (1) 最終 owner 行数の事前 COUNT。propertyOwners の select 条件と同一の
    //     「property が where に一致 × 所有者が非アーカイブ」のリンク数 = 最終行数。
    const ownerRowCount = mgmtShortCircuitEmpty
      ? 0
      : await prisma.propertyOwner.count({
          where: { ...eligibleOwnerWhere, property: where },
        });
    if (ownerRowCount > MAX_DM_EXPORT_ROWS) {
      throw new ApiError(
        400,
        "出力対象が上限（10,000件）を超えています。検索条件で絞り込んでください。",
        "EXPORT_LIMIT_EXCEEDED",
      );
    }

    // (2) 非アーカイブ所有者を 1 名以上持つ物件のみ取得（既存の AND マージと同イディオム）。
    //     owner 持ち物件が take 窓（MAX+1 件）を超える場合は各物件が 1 行以上を生むため
    //     行数も必ず MAX を超え、(3) で 400 になる。窓内に収まる場合は全件取得済みとなり、
    //     どちらのケースでも「eligible owner 行を落とした 200 CSV」は返らない。
    const whereWithEligibleOwners = {
      ...where,
      AND: [
        ...(where.AND ?? []),
        { propertyOwners: { some: eligibleOwnerWhere } },
      ],
    };

    // mgmtId 検索が 0 件で短絡する場合は DB を叩かず空結果にする（export route と同方針）。
    const properties = mgmtShortCircuitEmpty
      ? []
      : await prisma.property.findMany({
          where: whereWithEligibleOwners,
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

    // (3) 取得済みデータの owner 行数で再判定。超過時は切り捨てず、取込元逆引き・
    //     CSV 生成・AuditLog より前で 400 にする（不完全な差込 CSV を渡さない / DoS 防止）。
    const totalOwnerRows = properties.reduce(
      (n, p) => n + p.propertyOwners.length,
      0,
    );
    if (totalOwnerRows > MAX_DM_EXPORT_ROWS) {
      throw new ApiError(
        400,
        "出力対象が上限（10,000件）を超えています。検索条件で絞り込んでください。",
        "EXPORT_LIMIT_EXCEEDED",
      );
    }

    // 取込元（管理ID）を一括逆引き（一覧 API と共有・N+1 回避）。
    const importSourceMap = await loadImportSourceMap(
      prisma,
      properties.map((p) => p.id),
    );

    // 所有者 1 名 = 1 行に展開。非アーカイブ所有者が 0 件の物件は行を生まず skipped に数える。
    // （fetch 対象は所有者あり物件に限定済みのため、本番でこの skip 分岐に入るのは
    //   fetch 間際に所有者がアーカイブされた race のみ。防御として残す）
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

    // 上限判定は (1)〜(3) で実施済み（rows.length === totalOwnerRows）。
    // ownerなし送付可物件は fetch 対象から外したため、skippedCount は COUNT で正確に数える。
    // （従来は take 窓内のみの計上だったが、全 matching 範囲の件数になる。
    //   loop 側の skip 加算は上記 race の防御として残し、二重計上は通常発生しない）
    if (!mgmtShortCircuitEmpty) {
      skippedCount += await prisma.property.count({
        where: {
          ...where,
          AND: [
            ...(where.AND ?? []),
            { propertyOwners: { none: eligibleOwnerWhere } },
          ],
        },
      });
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
