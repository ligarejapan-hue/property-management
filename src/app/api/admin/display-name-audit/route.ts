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
import { normalizeName, normalizeBuildingName } from "@/lib/normalize";
import {
  buildDisplayNameAuditGroups,
  type AuditResult,
} from "@/lib/display-name-audit";
import { encodeCsv, sanitizeCsvCellForExcel } from "@/lib/csv-encode";

// ---------- GET /api/admin/display-name-audit ----------
//
// 表示名監査（read-only）。同一の正規化名キーに生 name が2バリアント以上ある群を
// Owner / Building で検出し、admin 限定で可視化する。データ更新・統一適用は一切しない。
//
// 認可:
//  - admin ガード: user_management:read（既存 admin データ補正ツールと同じゲート）
//  - 所有者名は PII。生値を返すため owner:read かつ name 表示レベルが生値（full/read/edit）の
//    場合のみ owner 群を返す。不足時は owner 群は空（building 群は非PIIのため返す）。
//
// 出力:
//  - 既定 JSON: { owner?: AuditResult, building?: AuditResult }
//  - ?format=csv: 種別,正規化キー,表示名,件数,対象ID を行展開（既存 csv ユーティリティ流用）
//  - ?entity=owner|building: 片方のみ（既定は両方）
//
// 監査ログ: 操作種別 display_name_audit_view のみ。生 name 等の PII 本文は残さない。

// 群数の安全上限。超過は silent 切り捨てせず truncated:true を返す。
const MAX_GROUPS = 1000;

// owner の name を生値で表示してよい表示レベル（maskValue が生値を返すレベルと一致）。
const RAW_NAME_LEVELS = new Set(["full", "read", "edit"]);

type Entity = "owner" | "building";

const CSV_HEADERS = ["種別", "正規化キー", "表示名", "件数", "対象ID"] as const;

const ENTITY_LABEL: Record<Entity, string> = {
  owner: "所有者",
  building: "建物",
};

// AuditResult を CSV 行（バリアント1行ずつ）に展開する。
function auditResultToRows(
  entity: Entity,
  result: AuditResult,
): Array<Record<string, string>> {
  const label = ENTITY_LABEL[entity];
  const rows: Array<Record<string, string>> = [];
  for (const group of result.groups) {
    for (const variant of group.variants) {
      rows.push({
        種別: label,
        正規化キー: group.key,
        表示名: variant.name,
        件数: String(variant.count),
        対象ID: variant.ids.join(";"),
      });
    }
  }
  return rows;
}

export async function GET(request: NextRequest) {
  try {
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    // admin ガード。権限不足時は DB 取得・CSV 生成・AuditLog 書き込みを一切行わない。
    if (!hasPermission(permissions, "user_management", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const { searchParams } = new URL(request.url);
    const entityParam = searchParams.get("entity");
    const wantOwner = entityParam !== "building";
    const wantBuilding = entityParam !== "owner";
    const asCsv = searchParams.get("format") === "csv";

    // owner 群は PII。owner:read かつ name 表示レベルが生値レベルの場合のみ返す。
    // owner を要求していない（entity=building）場合は owner 表示設定の解決自体を行わない。
    let ownerNameVisible = false;
    if (wantOwner && hasPermission(permissions, "owner", "read")) {
      const ownerDisplayConfig = await getOwnerDisplayConfig(
        session.id,
        permissions,
      );
      ownerNameVisible = RAW_NAME_LEVELS.has(ownerDisplayConfig.name);
    }

    // 取得は findMany のみ（書込なし）。列は id/name に最小化。
    // Owner は isArchived があるため dedup と一貫して archived を除外。
    // Building は isArchived カラムが無いため archived 条件は付けない。
    let ownerResult: AuditResult | undefined;
    if (wantOwner) {
      if (ownerNameVisible) {
        const owners = await prisma.owner.findMany({
          where: { isArchived: false },
          select: { id: true, name: true },
        });
        ownerResult = buildDisplayNameAuditGroups(owners, normalizeName, {
          maxGroups: MAX_GROUPS,
        });
      } else {
        // 表示レベル不足: owner 群は空（building は返す）。DB も叩かない。
        ownerResult = { groups: [], truncated: false };
      }
    }

    let buildingResult: AuditResult | undefined;
    if (wantBuilding) {
      const buildings = await prisma.building.findMany({
        where: {},
        select: { id: true, name: true },
      });
      buildingResult = buildDisplayNameAuditGroups(
        buildings,
        normalizeBuildingName,
        { maxGroups: MAX_GROUPS },
      );
    }

    // 監査ログ: 操作事実のみ。生 name 等の PII 本文は残さない（群数・バリアント数のみ）。
    await writeAuditLog({
      userId: session.id,
      action: "display_name_audit_view",
      detail: {
        entity: entityParam ?? "all",
        format: asCsv ? "csv" : "json",
        ...(ownerResult
          ? {
              ownerGroupCount: ownerResult.groups.length,
              ownerTruncated: ownerResult.truncated,
              ownerNameVisible,
            }
          : {}),
        ...(buildingResult
          ? {
              buildingGroupCount: buildingResult.groups.length,
              buildingTruncated: buildingResult.truncated,
            }
          : {}),
        viewedAt: new Date().toISOString(),
      },
    });

    if (asCsv) {
      const rows: Array<Record<string, string>> = [];
      if (ownerResult) rows.push(...auditResultToRows("owner", ownerResult));
      if (buildingResult)
        rows.push(...auditResultToRows("building", buildingResult));

      // formula injection 対策: 全セル値を sanitize（先頭 = + - @ tab CR LF に ' 付与）。
      const sanitizedRows = rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            sanitizeCsvCellForExcel(value),
          ]),
        ),
      );

      const csv = encodeCsv([...CSV_HEADERS], sanitizedRows, { bom: true });
      const fileDate = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="display-name-audit_${fileDate}.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }

    return NextResponse.json({
      ...(ownerResult ? { owner: ownerResult } : {}),
      ...(buildingResult ? { building: buildingResult } : {}),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
