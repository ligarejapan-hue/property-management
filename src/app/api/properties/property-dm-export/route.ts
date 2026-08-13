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
  PROPERTY_DM_EXPORT_HEADERS,
  MAX_PROPERTY_DM_EXPORT_ROWS,
  isPlainOwnerLevel,
  buildPropertyDmRow,
  type PropertyDmRowProperty,
  type PropertyDmRowPropertyOwner,
} from "@/lib/property-dm-export";

// ---------- GET /api/properties/property-dm-export ----------
//
// 物件一覧と同じ検索・フィルタ・sort・field_staff スコープを共有しつつ、
// サーバ側で dmStatus=send / isArchived=false を強制し、「送付可」の物件を
// 「1 物件 = 1 行」で物件住所宛の DM 差込用 CSV に出力する。
//   - 宛先 = Property.postalCode(→ Building.postalCode フォールバック)+ Property.address。
//   - 宛名 = 代表所有者名 + 敬称(個人=様 / 法人=御中・複数は「<敬称> 他共有者様」)。
//   - 所有者の郵便番号・住所は出力しない(宛先は物件住所のため)。
//
// 安全上限: MAX_PROPERTY_DM_EXPORT_ROWS 行(最終 CSV 行 = 物件数)。1 物件 = 1 行のため
// 取得物件数の単段判定で足りる(take=MAX+1 で MAX 超なら全件性を保証できないので 400)。
//
// PII / 権限:
//  - property:read / csv_export:read / csv_export_personal:read / owner:read すべて必須
//  - 加えて owner 氏名の表示レベルが「生値を返すレベル」でなければ 403
//    (宛名に生の氏名が必須。zip/address は出力しないため表示レベルを要求しない=所有者宛DMより緩和)
//  - 権限不足時は DB 取得・CSV 生成・AuditLog 書き込みを一切行わない
//  - CSV 本文・所有者名などの PII は AuditLog に保存しない

// AuditLog の filters に残してよいキー(export route と同方針の allowlist)。
// mgmtId / keyword は PII を含み得るため除外。dmStatus は常に "send" を明示付与。
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
  "dmSentMax",
  // 再送候補で絞った出力かを監査にも残す(非PIIのフラグ)。3つの export 系 route で
  // 揃えないと、同じ条件の出力なのに route ごとに監査の見え方が変わる(PR-C)。
  "resendOnly",
  "sortBy",
  "sortOrder",
] as const;

export async function GET(request: NextRequest) {
  try {
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    // 権限ゲート。いずれか欠ける場合はここで 403 とし、DB 取得・CSV 生成・AuditLog は行わない。
    if (!hasPermission(permissions, "property", "read")) {
      throw new ApiError(403, "物件一覧の閲覧権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(permissions, "csv_export", "read")) {
      throw new ApiError(403, "CSV エクスポートの権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(permissions, "csv_export_personal", "read")) {
      throw new ApiError(403, "個人情報を含む CSV エクスポートの権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(permissions, "owner", "read")) {
      throw new ApiError(403, "所有者情報の閲覧権限がありません", "FORBIDDEN");
    }

    // 宛名に生の氏名が必須。氏名の表示レベルが「生値を返すレベル(full/read/edit)」でなければ 403。
    // zip/address は物件住所を使うため出力せず、表示レベルも要求しない(所有者宛DMより緩和)。
    const ownerDisplayConfig = await getOwnerDisplayConfig(session.id, permissions);
    if (!isPlainOwnerLevel(ownerDisplayConfig.name)) {
      throw new ApiError(
        403,
        "DM差込CSV出力に必要な所有者名の表示権限がありません",
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
    const { where, mgmtShortCircuitEmpty, mgmtOverflowed } = await buildPropertyListWhere(query, session);

    // ⚠管理ID の一致が上限を超えて切り捨てられているときは、**最終行数が上限未満でも**
    // 出力しない (@codex #330 R2)。where は管理IDに加えて案件状況・DM状況・日付・
    // field_staff スコープを AND するため、切り捨てた id 側にだけ条件を満たす行が
    // あると、下の行数ガードが発火しないまま取りこぼした CSV が出てしまう。
    if (mgmtOverflowed) {
      throw new ApiError(
        400,
        "管理IDに一致する物件が多すぎます（上限10,000件）。管理IDをより具体的に指定するか、他の条件で絞り込んでください。",
        "EXPORT_LIMIT_EXCEEDED",
      );
    }


    // サーバ側で強制: 送付可のみ・アーカイブ除外。client の dmStatus/includeArchived は無視。
    where.dmStatus = "send";
    where.isArchived = false;

    const orderBy = buildPropertyListOrderBy(query);

    // 宛名に所有者名が必須なので、非アーカイブ所有者を 1 名以上持つ物件のみ取得する
    // (既存の AND マージと同イディオム・clobber しない)。
    const whereWithOwners = {
      ...where,
      AND: [
        ...(where.AND ?? []),
        { propertyOwners: { some: { owner: { isArchived: false } } } },
      ],
    };

    const properties = mgmtShortCircuitEmpty
      ? []
      : await prisma.property.findMany({
          where: whereWithOwners,
          select: {
            id: true,
            address: true,
            postalCode: true,
            propertyType: true,
            roomNo: true,
            // 郵便番号フォールバック用に建物の郵便番号を取得する(住所は物件側を使う)。
            building: { select: { postalCode: true } },
            propertyOwners: {
              where: { owner: { isArchived: false } },
              select: {
                isPrimary: true,
                owner: { select: { name: true, corporateNumber: true } },
              },
              orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
            },
          },
          orderBy,
          take: MAX_PROPERTY_DM_EXPORT_ROWS + 1,
        });

    // 1 物件 = 1 行。take 窓(MAX+1)を埋めた = 全件性を保証できないため 400。
    // これは取込元逆引き・CSV 生成・AuditLog より前に走る安全側ガード。
    if (properties.length > MAX_PROPERTY_DM_EXPORT_ROWS) {
      throw new ApiError(
        400,
        "出力対象が上限（10,000件）を超えています。検索条件で絞り込んでください。",
        "EXPORT_LIMIT_EXCEEDED",
      );
    }

    // some 述語で所有者ありに絞っているが、race 防御として空所有者は行にしない。
    const exportable = properties.filter((p) => p.propertyOwners.length > 0);

    // 取込元(管理ID)を一括逆引き(一覧 API と共有・N+1 回避)。
    const importSourceMap = await loadImportSourceMap(
      prisma,
      exportable.map((p) => p.id),
    );

    const rows: Array<Record<string, string>> = exportable.map((p) =>
      buildPropertyDmRow(
        p as unknown as PropertyDmRowProperty,
        p.propertyOwners as unknown as PropertyDmRowPropertyOwner[],
        ownerDisplayConfig,
        importSourceMap.get(p.id) ?? "",
      ),
    );

    // skippedCount: 送付可だが非アーカイブ所有者 0 名の物件(宛名が作れず除外)を全範囲 COUNT。
    // 取得ウィンドウに依存しない正確な件数。400 経路では実行しない(上で throw 済み)。
    let skippedCount = 0;
    if (!mgmtShortCircuitEmpty) {
      skippedCount = await prisma.property.count({
        where: {
          ...where,
          AND: [
            ...(where.AND ?? []),
            { propertyOwners: { none: { owner: { isArchived: false } } } },
          ],
        },
      });
    }

    // CSV formula injection 対策: 全セルを encodeCsv に渡す前に無害化する。
    const sanitizedRows = rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key, sanitizeCsvCellForExcel(value)]),
      ),
    );

    // UTF-8 BOM + CRLF(encodeCsv の既定挙動)で Excel 互換に出力。
    const csv = encodeCsv([...PROPERTY_DM_EXPORT_HEADERS], sanitizedRows, { bom: true });

    // AuditLog は操作事実のみ。CSV 本文・所有者名などの PII は残さない。
    const filtersForLog: Record<string, unknown> = { dmStatus: "send" };
    for (const key of AUDIT_FILTER_KEYS) {
      const value = query[key];
      if (value !== undefined) filtersForLog[key] = value;
    }
    await writeAuditLog({
      userId: session.id,
      action: "property_address_dm_csv_export",
      targetTable: "properties",
      detail: {
        filters: filtersForLog,
        count: rows.length,
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
        "Content-Disposition": `attachment; filename="property_dm_${fileDate}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
