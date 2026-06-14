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
//    場合のみ owner 群を返す。不足時は owner 群は空。
//  - building 名/ID を返す経路は property:read を要求する（既存の建物読み取り API
//    GET /api/buildings と同一基準）。不足時は building 群を空で返す（fail-closed）。
//  - ?format=csv（CSV 出力という行為）は entity を問わず csv_export:read を一般ゲートとして
//    要求する（既存 CSV 出力ルートと同じ作法）。不足時は結果を空にするのでなく 403 で拒否する。
//    さらに所有者名（PII）・ID を CSV 出力する経路（既定 all / entity=owner）は
//    csv_export_personal:read も追加で要求し、不足時は 403（空 owner CSV を返さない）。
//    （既存の PII CSV 出力ルート＝物件 CSV export / DM export と同じ fail-closed 基準）。
//    building（非PII）のみの CSV は csv_export:read だけで足り personal は不要。
//    さらに entity 単独（owner のみ / building のみ）の CSV で当該結果が権限不足の
//    未スキャン（unavailable）になる場合は 403 で拒否する。CSV は JSON と違い
//    unavailable フラグを表現できず、ヘッダのみの空 CSV が「指摘ゼロ（clean）」と
//    区別できないため（既定の両 entity CSV は他方が出力され区別可能ゆえ対象外）。
//    JSON 閲覧（owner=owner:read + 表示レベル / building=property:read）は CSV 権限に
//    依らず従来どおり（空/返すの既存挙動を維持・unavailable はフラグで区別）。
//
// 出力:
//  - 既定 JSON: { owner?: AuditResult, building?: AuditResult }
//  - ?format=csv: 種別,正規化キー,表示名,件数,対象ID を行展開（既存 csv ユーティリティ流用）
//  - ?entity=owner|building: 片方のみ（既定は両方）
//
// 監査ログ: 操作種別 display_name_audit_view のみ。生 name 等の PII 本文は残さない。

// 群数の安全上限。超過は silent 切り捨てせず truncated:true を返す。
const MAX_GROUPS = 1000;

// スキャン（行）上限。Owner/Building が異常に多い、または単一の正規化キーに
// 大量の生バリアントがある場合に、全件 findMany ＋ 全 variant ID 保持で
// メモリ/負荷が過大になるのを防ぐ安全弁（既存 corporate-number-candidates の
// MAX_SCAN と同型）。findMany は take: MAX_SCAN+1 で取得し、超過分は集計前に
// 切り捨てたうえで truncated:true を立てる（silent 切り捨てしない）。
// MAX_GROUPS（出力群数の上限）とは別レイヤ。どちらの上限に掛かっても truncated。
const MAX_SCAN = 10_000;

/**
 * findMany が take: MAX_SCAN+1 で取得した行を、集計前に MAX_SCAN 件へ切り詰める。
 * 超過していたら scanTruncated=true を返す（出力に明示するため）。
 */
function capScan<T>(rows: T[]): { scanned: T[]; scanTruncated: boolean } {
  const scanTruncated = rows.length > MAX_SCAN;
  return {
    scanned: scanTruncated ? rows.slice(0, MAX_SCAN) : rows,
    scanTruncated,
  };
}

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

    // 監査ログに記録する entity は canonical 値のみに正規化する。
    // 生のクエリ文字列（entityParam）は所有者名・トークン等の任意 PII/秘密を
    // 含み得るため、AuditLog.detail には絶対に入れない（PII 本文非記録方針の強化）。
    // 既知の owner/building 以外は既存挙動どおり両方を返す＝"all" に畳む。
    const auditEntity: "owner" | "building" | "all" = wantOwner
      ? wantBuilding
        ? "all"
        : "owner"
      : "building";

    // building 名/ID は property:read を要求する（既存の建物読み取り API と同一基準）。
    // 不足時は building 群を空で返す（owner と同じ fail-closed・DB も叩かない）。
    const buildingReadable = hasPermission(permissions, "property", "read");

    // CSV 出力（format=csv）の権限ゲート。既存の PII CSV 出力ルート
    // （物件 CSV export / DM export）と同じく、権限不足時は「結果を空にする」のでなく
    // 403 で拒否する（fail-closed）。ここで弾くため DB 取得・CSV 生成・AuditLog 書き込みは
    // 一切行わない。CSV 権限が CSV 出力という行為を保護する意味を維持する（Codex P2 是正）。
    if (asCsv) {
      // CSV 出力という行為の一般ゲート。entity 非依存（building が非PII でも必須）。
      if (!hasPermission(permissions, "csv_export", "read")) {
        throw new ApiError(
          403,
          "CSV エクスポートの権限がありません",
          "FORBIDDEN",
        );
      }
      // owner（所有者名＝PII）を CSV に含む要求は csv_export_personal:read も必須。
      // 既定（両 entity）/entity=owner はいずれも owner を含む。
      if (wantOwner && !hasPermission(permissions, "csv_export_personal", "read")) {
        throw new ApiError(
          403,
          "個人情報を含む CSV エクスポートの権限がありません",
          "FORBIDDEN",
        );
      }
    }

    // owner 群（PII）を返す条件:
    //  - owner:read かつ name 表示レベルが生値レベル
    // CSV 出力時の CSV 権限は上で 403 ゲート済み。
    // owner を要求していない（entity=building）場合は owner 表示設定の解決・
    // owner の DB 取得自体を行わない（fail-closed）。
    let ownerNameVisible = false;
    if (wantOwner && hasPermission(permissions, "owner", "read")) {
      const ownerDisplayConfig = await getOwnerDisplayConfig(
        session.id,
        permissions,
      );
      ownerNameVisible = RAW_NAME_LEVELS.has(ownerDisplayConfig.name);
    }

    // CSV 出力で entity が単独（owner のみ / building のみ）の場合、選択した entity が
    // 権限不足で未スキャン（unavailable）だと、CSV はヘッダのみの空出力になる。
    // CSV は JSON と違い unavailable フラグを表現できないため、空ヘッダ CSV は
    // 「指摘ゼロ（clean）」と区別できない（直接ダウンロードした owner-only / building-only
    // 監査が誤って clean に見える）。よって entity 単独 CSV で当該結果が unavailable なら
    // 403 で拒否する（既存 CSV ルートと同じ fail-closed・DB/CSV/AuditLog を行わない・Codex P2 是正）。
    // owner の unavailable = owner:read 不足 or name 表示レベル不足（ownerNameVisible=false）。
    // building の unavailable = property:read 不足（buildingReadable=false）。
    // 既定（両 entity）は単独でないため対象外: 片方 unavailable でも他方が出力されれば
    // 空ヘッダにはならず clean と区別できる（JSON の unavailable 区別を維持）。
    if (asCsv) {
      const ownerOnly = wantOwner && !wantBuilding;
      const buildingOnly = wantBuilding && !wantOwner;
      if (
        (ownerOnly && !ownerNameVisible) ||
        (buildingOnly && !buildingReadable)
      ) {
        throw new ApiError(
          403,
          "権限不足のため CSV を出力できません",
          "FORBIDDEN",
        );
      }
    }

    // 取得は findMany のみ（書込なし）。列は id/name に最小化。
    // Owner は isArchived があるため dedup と一貫して archived を除外。
    // Building は isArchived カラムが無いため archived 条件は付けない。
    let ownerResult: AuditResult | undefined;
    if (wantOwner) {
      if (ownerNameVisible) {
        // scan 上限ぶん +1 を取得し、超過判定後に MAX_SCAN 件へ切り詰める。
        const owners = await prisma.owner.findMany({
          where: { isArchived: false },
          select: { id: true, name: true },
          // 決定的順序。take（行上限）だけだと DB が任意順で返し、超過時に
          // cap されるサブセットが実行ごとに変わる（非決定的）。安定一意キー
          // id 昇順で固定し、同一データなら同一サブセットを集計する（Codex P2 是正）。
          orderBy: { id: "asc" },
          take: MAX_SCAN + 1,
        });
        const { scanned, scanTruncated } = capScan(owners);
        const grouped = buildDisplayNameAuditGroups(scanned, normalizeName, {
          maxGroups: MAX_GROUPS,
        });
        // scan 上限・群数上限のいずれに掛かっても truncated を立てる
        // （scan 切り捨てを silent にしない）。
        ownerResult = {
          ...grouped,
          truncated: grouped.truncated || scanTruncated,
        };
      } else {
        // owner:read 不足 または name 表示レベル不足: owner 群は空（building は返す）。
        // DB も叩かない。空 groups を「指摘ゼロ（clean）」と誤認させないため
        // unavailable:true を立てる（権限不足で未スキャン＝UI で別表示する・Codex P2 是正）。
        ownerResult = { groups: [], truncated: false, unavailable: true };
      }
    }

    // building 群を返す条件:
    //  - property:read（既存 JSON 基準）
    // CSV 出力時の csv_export:read は上で 403 ゲート済み（building は非PII ゆえ
    // csv_export_personal は不要）。property:read が無い場合は building を載せない
    // （DB も叩かない・fail-closed・CSV/JSON 共通）。
    const buildingOutputAllowed = wantBuilding && buildingReadable;

    let buildingResult: AuditResult | undefined;
    if (wantBuilding) {
      if (buildingOutputAllowed) {
        // scan 上限ぶん +1 を取得し、超過判定後に MAX_SCAN 件へ切り詰める。
        const buildings = await prisma.building.findMany({
          where: {},
          select: { id: true, name: true },
          // owner と同様、scan cap を決定的にするため id 昇順で固定する（Codex P2 是正）。
          orderBy: { id: "asc" },
          take: MAX_SCAN + 1,
        });
        const { scanned, scanTruncated } = capScan(buildings);
        const grouped = buildDisplayNameAuditGroups(
          scanned,
          normalizeBuildingName,
          { maxGroups: MAX_GROUPS },
        );
        buildingResult = {
          ...grouped,
          truncated: grouped.truncated || scanTruncated,
        };
      } else {
        // property:read 不足: building 群は空（fail-closed）。DB も叩かない。
        // owner と同様、空 groups を clean と誤認させないため unavailable:true を立てる
        // （権限不足で未スキャン＝UI で別表示する・Codex P2 是正）。
        buildingResult = { groups: [], truncated: false, unavailable: true };
      }
    }

    // 監査ログ: 操作事実のみ。生 name 等の PII 本文は残さない（群数・バリアント数のみ）。
    await writeAuditLog({
      userId: session.id,
      action: "display_name_audit_view",
      detail: {
        // canonical 値のみ（生入力 entityParam は記録しない）。
        entity: auditEntity,
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
