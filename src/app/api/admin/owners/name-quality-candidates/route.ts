// GET /api/admin/owners/name-quality-candidates
//
// DQ-01: 既存 Owner の氏名（name / nameKana）から「氏名として成立しない値」
// （数値のみ / 記号のみ / 空白のみ / 制御文字 / 長短 / 数字過多 / カナ不正）を
// dry-run で検出して返す。DB は一切変更しない。
//
// 既存 correction-candidates / corporate-number-candidates と同型:
// - 権限: user_management:read AND owner:read
// - PII は maskValue 経由でマスク。AuditLog detail は type / 件数 / summary のみ。
// - blockReasons / recommendedAction を付与。cursor ページング + MAX_SCAN 安全弁。

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission, maskValue } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import {
  classifyOwnerNameQuality,
  decideOwnerNameFix,
  emptyOwnerNameQualitySummary,
  tallyOwnerNameQuality,
  type OwnerNameIssueCode,
  type OwnerNameKanaIssueCode,
  type OwnerNameSeverity,
} from "@/lib/owner-name-quality";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const MAX_SCAN = 10_000;

type RecommendedAction = "hold" | "review" | "sanitize_candidate";

// type フィルタ。info レベル（mostly_digits / kana_non_kana）は "all" では除外し、
// 明示指定時のみ表示する（誤検出ノイズを既定で抑える）。
type FilterType =
  | "all"
  | OwnerNameIssueCode
  | OwnerNameKanaIssueCode;

const ALL_TYPES: FilterType[] = [
  "all",
  "numeric_only",
  "symbol_only",
  "whitespace_only",
  "control_chars",
  "too_long",
  "too_short",
  "mostly_digits",
  "kana_non_kana",
];

// "all" に含める（= 既定表示する）error / warning 級の issue。
const DEFAULT_VISIBLE_ISSUES = new Set<OwnerNameIssueCode>([
  "numeric_only",
  "symbol_only",
  "whitespace_only",
  "control_chars",
  "too_long",
  "too_short",
]);

interface NameQualityRow {
  ownerId: string;
  ownerNameMasked: string | null;
  nameKanaMasked: string | null;
  issues: OwnerNameIssueCode[];
  kanaIssues: OwnerNameKanaIssueCode[];
  severity: OwnerNameSeverity | null;
  blockReasons: string[];
  recommendedAction: RecommendedAction;
  version: number;
  detailUrl: string;
}

function parseType(input: string | null): FilterType {
  if (input && (ALL_TYPES as string[]).includes(input)) {
    return input as FilterType;
  }
  return "all";
}

function parseLimit(input: string | null): number {
  if (!input) return DEFAULT_LIMIT;
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/**
 * display-level がそのフィールドの「生値」を見せるレベルか。
 * full / edit / read のみ生値可視。partial / masked / hidden は生値非可視。
 * maskValue の挙動（read 以上は生値、それ未満はマスク/null）と一致させる。
 *
 * DQ-01 P1: 生値非可視のフィールド（owner_name / owner_name_kana）は
 * classifyOwnerNameQuality をスキップ（= 分類させない）し、issue コード・summary を
 * 一切出さない。これにより、生値を見られないユーザーが issue コードや type= の
 * 件数差分から隠し PII の品質・性質を推測するオラクルを塞ぐ（DQ-02 と同方針）。
 */
function isRawVisible(level: string): boolean {
  return level === "full" || level === "edit" || level === "read";
}

function matchesFilter(
  result: { issues: OwnerNameIssueCode[]; kanaIssues: OwnerNameKanaIssueCode[] },
  filter: FilterType,
): boolean {
  if (filter === "all") {
    return result.issues.some((i) => DEFAULT_VISIBLE_ISSUES.has(i));
  }
  if (filter === "kana_non_kana") {
    return result.kanaIssues.includes("kana_non_kana");
  }
  return result.issues.includes(filter);
}

export async function GET(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "user_management", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(perms, "owner", "read")) {
      throw new ApiError(403, "所有者閲覧の権限がありません", "FORBIDDEN");
    }

    const displayConfig = await getOwnerDisplayConfig(session.id, perms);
    // DQ-01 P1: 各フィールドの生値が可視か（full/edit/read）。不可視のフィールドは
    // classifyOwnerNameQuality をスキップし、issue/summary/分類由来情報を一切出さない。
    const nameVisible = isRawVisible(displayConfig.name);
    const nameKanaVisible = isRawVisible(displayConfig.nameKana);

    const { searchParams } = new URL(request.url);
    const type = parseType(searchParams.get("type"));
    const limit = parseLimit(searchParams.get("limit"));
    const cursor = searchParams.get("cursor");

    // active Owner を id 昇順で取得（cursor 安定性のため）。
    //
    // ページング設計（Codex P2 対応）:
    //   cursor は DB クエリの where に id.gt として渡し、cursor 以降の owner だけを
    //   1 窓ぶん（最大 MAX_SCAN 件）スキャンする。これにより MAX_SCAN は
    //   「総件数の上限」ではなく「1 リクエストのスキャン窓サイズ」になり、
    //   cursor を進めれば全 owner 集合を窓単位で辿り切れる（10k 超も到達可能）。
    const owners = await prisma.owner.findMany({
      where: {
        isArchived: false,
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      select: {
        id: true,
        name: true,
        nameKana: true,
        note: true,
        corporateNumber: true,
        externalLinkKey: true,
        version: true,
        _count: { select: { propertyOwners: true } },
      },
      orderBy: { id: "asc" },
      take: MAX_SCAN + 1,
    });

    const truncated = owners.length > MAX_SCAN;
    const scanned = truncated ? owners.slice(0, MAX_SCAN) : owners;
    const ownerIds = scanned.map((o) => o.id);

    // ChangeLog 件数（owners は ChangeLog と直接リレーションなし）。
    const changeLogRows =
      ownerIds.length > 0
        ? await prisma.changeLog.findMany({
            where: { targetTable: "owners", targetId: { in: ownerIds } },
            select: { targetId: true },
          })
        : [];
    const changeLogCountMap = new Map<string, number>();
    for (const row of changeLogRows) {
      changeLogCountMap.set(
        row.targetId,
        (changeLogCountMap.get(row.targetId) ?? 0) + 1,
      );
    }

    // owner_csv ImportJobRow 逆引き（delete/fix 可否の blockReasons 用）。
    const importRows =
      ownerIds.length > 0
        ? await prisma.importJobRow.findMany({
            where: {
              createdId: { in: ownerIds },
              job: { jobType: "owner_csv" },
            },
            select: { createdId: true, status: true },
          })
        : [];
    const importStatusMap = new Map<string, string>();
    for (const r of importRows) {
      const existing = importStatusMap.get(r.createdId!);
      if (!existing || (existing !== "success" && r.status === "success")) {
        importStatusMap.set(r.createdId!, r.status);
      }
    }

    const summary = emptyOwnerNameQualitySummary();
    const matchedRows: NameQualityRow[] = [];

    for (const owner of scanned) {
      const result = classifyOwnerNameQuality(
        {
          name: owner.name,
          nameKana: owner.nameKana,
          corporateNumber: owner.corporateNumber,
        },
        { name: nameVisible, nameKana: nameKanaVisible },
      );
      tallyOwnerNameQuality(summary, result);

      if (!matchesFilter(result, type)) continue;

      const changeLogCount = changeLogCountMap.get(owner.id) ?? 0;
      const importStatus = importStatusMap.get(owner.id) ?? null;

      const blockReasons: string[] = [];
      if (owner._count.propertyOwners > 0)
        blockReasons.push("property_owner_exists");
      if (changeLogCount > 0) blockReasons.push("changelog_exists");
      if (owner.version > 1) blockReasons.push("version_gt_1");
      if (owner.externalLinkKey) blockReasons.push("external_link_key_exists");
      if (owner.note) blockReasons.push("note_exists");
      if (!importStatus) blockReasons.push("import_source_unknown");
      if (importStatus && importStatus !== "success")
        blockReasons.push("import_row_not_success");

      const hasSafeguard = blockReasons.some((r) =>
        [
          "property_owner_exists",
          "changelog_exists",
          "version_gt_1",
          "external_link_key_exists",
          "note_exists",
        ].includes(r),
      );

      // DQ-01 P1: sanitize_candidate は name 由来の自動補正可否（隠し name の性質）を
      // 漏らすため、name 不可視時は判定しない（review へ倒す）。name-fix 自体が
      // owner_name field-level write を要求するため、不可視ユーザーには無意味でもある。
      let recommendedAction: RecommendedAction;
      if (hasSafeguard) {
        recommendedAction = "hold";
      } else if (
        nameVisible &&
        decideOwnerNameFix(owner.name).action === "sanitize"
      ) {
        recommendedAction = "sanitize_candidate";
      } else {
        recommendedAction = "review";
      }

      matchedRows.push({
        ownerId: owner.id,
        ownerNameMasked: maskValue(owner.name, displayConfig.name),
        nameKanaMasked: maskValue(owner.nameKana, displayConfig.nameKana),
        issues: result.issues,
        kanaIssues: result.kanaIssues,
        severity: result.severity,
        blockReasons,
        recommendedAction,
        version: owner.version,
        detailUrl: `/admin/owners/${owner.id}`,
      });
    }

    // ページング（cursor は既に DB の where:{id:{gt:cursor}} で適用済み。
    // matchedRows は cursor 以降・このスキャン窓内の id 昇順マッチ）。
    const page = matchedRows.slice(0, limit);

    // 次ページの有無:
    //   - このスキャン窓内にまだ未返却のマッチがある (matchedRows.length > limit)
    //   - もしくは窓が truncated（窓の先にまだ owner が存在する＝次窓に
    //     マッチが現れる可能性がある）。silent な切り捨てを禁止する。
    const hasMoreInWindow = matchedRows.length > page.length;
    const hasNextPage = hasMoreInWindow || truncated;

    // nextCursor の前進:
    //   - 窓内にまだマッチが残るなら、返却した最後のマッチ id まで進める。
    //   - 窓内のマッチを使い切ったが truncated なら、最後にスキャンした owner の
    //     id（= 窓末尾）まで進める。これにより次リクエストは window の続きを
    //     スキャンでき、MAX_SCAN を超える owner にも到達できる。
    let nextCursor: string | null = null;
    if (hasMoreInWindow && page.length > 0) {
      nextCursor = page[page.length - 1].ownerId;
    } else if (hasNextPage && scanned.length > 0) {
      nextCursor = scanned[scanned.length - 1].id;
    }

    await writeAuditLog({
      userId: session.id,
      action: "owner_name_quality_candidates_list",
      detail: {
        type,
        resultCount: page.length,
        summary,
        hasNextPage,
        truncated,
      },
    });

    return apiResponse({
      type,
      candidates: page,
      summary,
      hasNextPage,
      nextCursor,
      truncated,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
