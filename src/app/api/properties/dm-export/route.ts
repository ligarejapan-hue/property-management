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
  groupPropertyOwnersByAddress,
  type DmRowPropertyOwner,
} from "@/lib/dm-export";

// ---------- GET /api/properties/dm-export ----------
//
// 物件一覧と同じ検索・フィルタ・sort・field_staff スコープを共有しつつ、
// サーバ側で dmStatus=send / isArchived=false を強制し、「送付可」の物件を
// 「同一物件内・同一送付先住所（Owner.zip + Owner.address）の共有者 = 1 行」に
// グルーピングして DM 差込用 CSV を出力する（名義違いでも同住所なら 1 通＝重複送付しない）。
//
// 安全上限: MAX_DM_EXPORT_ROWS 行（最終 CSV 行 = 送付先住所グループ数で判定）。
// 超過時は切り捨てず 400 にする（不完全な差込 CSV を渡さない / DoS 防止）。
// 「最終グループ行数が上限超なら必ず 400 / 部分 CSV の 200 を返さない」は
// 所有者あり物件のみを take=MAX+1 で取得し、(1) 取得物件数が MAX 超なら 400 /
// (2) グルーピング後の送付先グループ数が MAX 超なら 400、の 2 段で保証する。
// owner リンク数（共有者数）は同住所で 1 行に畳まれるため reject には使わない（false 400 回避・
// GET 内コメント参照）。
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

    // 上限判定は必ず「最終 CSV 行数 = 送付先住所グループ数」で行う。
    // owner リンク数（共有者数）は「グループ数の上限」ではあるが、同一住所の共有者は 1 行に
    // 畳まれるため、owner リンク数を hard reject に使うと正当な grouped export を false 400 に
    // してしまう（例: 1 物件に同住所の共有者 10,001 名 → 実際は 1 行なのに 400）。
    // そこで owner リンク数では reject せず、次の 2 段で「完全な CSV か 400 か」を保証する:
    //  (1) fetch 対象を「非アーカイブ所有者が 1 名以上の物件」に限定（ownerなし物件が
    //      property 窓を消費して eligible 物件を落とすのを防ぐ）+ take = MAX+1 件。
    //      取得物件数が MAX を超えた（窓を埋め切った）= 未取得の eligible 物件が残り得る
    //      → 全件性を保証できないため 400（取得「物件数」での安全側カット。owner 数ではない）。
    //  (2) 取得後にグルーピングし、最終 CSV 行数（送付先グループ数）が MAX 超なら 400。
    //      取得物件数が MAX 以下なら eligible 物件は全件取得済みのため、グループ数 = 真の総行数。
    const eligibleOwnerWhere = { owner: { isArchived: false } };

    // (1) 非アーカイブ所有者を 1 名以上持つ物件のみ取得（既存の AND マージと同イディオム）。
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

    // (1) 取得した eligible 物件が take 窓（MAX+1 件）を埋めた = eligible 物件が MAX 件超存在し、
    //     未取得分が残り得る → 全件性を保証できないため 400（PII 行マッピング前・取込元逆引き前）。
    //     ここは owner リンク数ではなく「取得物件数」で判定する（同住所共有者は 1 行に畳まれるので
    //     owner 数での reject は false 400 になる）。物件数 ≤ MAX なら eligible 物件は全件取得済み。
    if (properties.length > MAX_DM_EXPORT_ROWS) {
      throw new ApiError(
        400,
        "出力対象が上限（10,000件）を超えています。検索条件で絞り込んでください。",
        "EXPORT_LIMIT_EXCEEDED",
      );
    }

    // 物件ごとに「同一送付先住所（Owner.zip + Owner.address）の共有者 = 1 行」へグループ化する。
    // 取込元逆引き・行マッピングより前にグルーピングし、最終行数（グループ数）で上限を再判定する。
    //  - Owner.address 空欄の所有者は送付先不明として skip（skippedAddressMissingCount に計上）。
    //  - グループが 0 件になった物件（全員 address 空欄等）は行を生まず skippedCount に数える。
    //  - 同一住所の共有者は名義違いでも 1 通にまとめる（未成年・家族名義への個別 DM を回避）。
    const grouped = properties.map((p) => ({
      property: p,
      ...groupPropertyOwnersByAddress(p.propertyOwners as DmRowPropertyOwner[]),
    }));

    // skippedCount は既存の意味（非アーカイブ所有者 0 件の物件）を維持する。
    // address 空欄による送付先欠落は別カウント（skippedAddressMissingCount）に分け、
    // skippedCount や行数の意味を混ぜない（既存差込運用・監査の互換維持）。
    let mailablePropertyCount = 0;
    let skippedCount = 0;
    let skippedAddressMissingCount = 0;
    let totalRows = 0;
    for (const g of grouped) {
      skippedAddressMissingCount += g.skippedAddressCount;
      if (g.property.propertyOwners.length === 0) {
        // 非アーカイブ所有者 0 件（既存 skippedCount の意味そのもの・race 防御）。
        skippedCount += 1;
        continue;
      }
      if (g.groups.length === 0) {
        // 所有者は居るが全員 address 空欄 → 送付先 0 件。
        // これは「所有者 0 件」ではないため skippedCount には混ぜない
        //（欠落は skippedAddressMissingCount に計上済み）。
        continue;
      }
      mailablePropertyCount += 1;
      totalRows += g.groups.length;
    }

    // (2) 最終 CSV 行数（送付先住所グループ数）で判定。超過時は切り捨てず、取込元逆引き・
    //     CSV 生成・AuditLog より前で 400 にする（不完全な差込 CSV を渡さない / DoS 防止）。
    //     (1) で取得物件数 ≤ MAX を確認済みのため eligible 物件は全件取得済み = totalRows は
    //     真の総送付先数。少数物件に多数の異住所共有者が居て totalRows が膨らむケースをここで捕捉。
    if (totalRows > MAX_DM_EXPORT_ROWS) {
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

    // 各グループ = 1 行に展開（宛名・送付先一覧・共有者数は buildDmRow が生成）。
    const rows: Array<Record<string, string>> = [];
    for (const g of grouped) {
      if (g.groups.length === 0) continue;
      const importSourceValue = importSourceMap.get(g.property.id) ?? "";
      for (const group of g.groups) {
        rows.push(buildDmRow(g.property, group, ownerDisplayConfig, importSourceValue));
      }
    }

    // 上限判定は (1)〜(3) で実施済み（rows.length === totalRows）。
    // ownerなし送付可物件は fetch 対象から外したため、skippedCount は COUNT で正確に数える。
    // （ここで数えるのは「非アーカイブ所有者が 0 名」の物件。address 空欄で送付先 0 件に
    //   なった物件は上の loop で skippedCount に加算済みで、none 条件とは別集合のため二重計上しない）
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
        skippedAddressMissingCount,
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
