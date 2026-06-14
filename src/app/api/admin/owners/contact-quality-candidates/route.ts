// GET /api/admin/owners/contact-quality-candidates
//
// DQ-02: 既存 Owner の zip / phone から「形式が怪しい / 未整形」のものを dry-run で
// 検出して返す。DB は一切変更しない。
//
// 既存 name-quality-candidates / corporate-number-candidates と同型:
// - 権限: user_management:read AND owner:read
// - PII（zip/phone）は maskValue 経由でマスク。AuditLog detail は type/件数/summary のみ。
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
  classifyOwnerContact,
  emptyOwnerContactSummary,
  tallyOwnerContact,
  type OwnerContactIssueCode,
  type ContactSeverity,
} from "@/lib/owner-contact-format";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const MAX_SCAN = 10_000;

type RecommendedAction = "hold" | "review" | "format_candidate";

type FilterType = "all" | OwnerContactIssueCode;

const ALL_TYPES: FilterType[] = [
  "all",
  "zip_suspicious",
  "zip_unformatted",
  "phone_suspicious",
  "phone_non_phone",
  "phone_unnormalized",
];

// "all" に含める（既定表示する）warning 級の issue。info（未整形/未正規化）は明示指定時のみ。
const DEFAULT_VISIBLE_ISSUES = new Set<OwnerContactIssueCode>([
  "zip_suspicious",
  "phone_suspicious",
  "phone_non_phone",
]);

// 自動整形で安全に直せる info 級 issue（format_candidate 判定に使う）。
const FORMAT_ISSUES = new Set<OwnerContactIssueCode>([
  "zip_unformatted",
  "phone_unnormalized",
]);

interface ContactQualityRow {
  ownerId: string;
  zipMasked: string | null;
  phoneMasked: string | null;
  issues: OwnerContactIssueCode[];
  severity: ContactSeverity | null;
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

function matchesFilter(
  issues: OwnerContactIssueCode[],
  filter: FilterType,
): boolean {
  if (filter === "all") return issues.some((i) => DEFAULT_VISIBLE_ISSUES.has(i));
  return issues.includes(filter);
}

/**
 * display-level がそのフィールドの「生値」を見せるレベルか。
 * full / edit / read のみ生値可視。partial / masked / hidden は生値非可視。
 * maskValue の挙動（read 以上は生値、それ未満はマスク/null）と一致させる。
 *
 * DQ-02 P1: 生値非可視のフィールドは classifyOwnerContact をスキップし、
 * issue コード・summary を一切出さない（隠し値の品質を推測させない）。
 */
function isRawVisible(level: string): boolean {
  return level === "full" || level === "edit" || level === "read";
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
    // DQ-02 P1: 各 PII フィールドの生値が可視か（full/edit/read）。不可視のフィールドは
    // classifyOwnerContact をスキップし、issue/summary/分類由来情報を一切出さない。
    const zipVisible = isRawVisible(displayConfig.zip);
    const phoneVisible = isRawVisible(displayConfig.phone);

    const { searchParams } = new URL(request.url);
    const type = parseType(searchParams.get("type"));
    const limit = parseLimit(searchParams.get("limit"));
    const cursor = searchParams.get("cursor");

    const owners = await prisma.owner.findMany({
      where: { isArchived: false },
      select: {
        id: true,
        zip: true,
        phone: true,
        note: true,
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

    const summary = emptyOwnerContactSummary();
    const matchedRows: ContactQualityRow[] = [];

    for (const owner of scanned) {
      const result = classifyOwnerContact(
        { zip: owner.zip, phone: owner.phone },
        { zip: zipVisible, phone: phoneVisible },
      );
      tallyOwnerContact(summary, result);

      if (!matchesFilter(result.issues, type)) continue;

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

      let recommendedAction: RecommendedAction;
      if (hasSafeguard) {
        recommendedAction = "hold";
      } else if (result.issues.every((i) => FORMAT_ISSUES.has(i))) {
        // 整形だけで安全に直せる（valid だが未整形/未正規化のみ）
        recommendedAction = "format_candidate";
      } else {
        recommendedAction = "review";
      }

      matchedRows.push({
        ownerId: owner.id,
        zipMasked: maskValue(owner.zip, displayConfig.zip),
        phoneMasked: maskValue(owner.phone, displayConfig.phone),
        issues: result.issues,
        severity: result.severity,
        blockReasons,
        recommendedAction,
        version: owner.version,
        detailUrl: `/admin/owners/${owner.id}`,
      });
    }

    const startIndex = cursor
      ? matchedRows.findIndex((r) => r.ownerId > cursor)
      : 0;
    const offset = startIndex < 0 ? matchedRows.length : startIndex;
    const page = matchedRows.slice(offset, offset + limit);
    const hasNextPage = offset + limit < matchedRows.length;
    const nextCursor =
      hasNextPage && page.length > 0 ? page[page.length - 1].ownerId : null;

    await writeAuditLog({
      userId: session.id,
      action: "owner_contact_quality_candidates_list",
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
