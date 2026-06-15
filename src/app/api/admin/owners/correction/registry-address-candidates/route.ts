// GET /api/admin/owners/correction/registry-address-candidates
//
// DQ-03: 既存 Owner の address から登記由来文字列（受付番号/和暦日付/登記原因/持分/証明書定型文
// = 除去可能、地番ラベル/不動産番号/床面積 等 = 監査専用）を検出し dry-run で一覧。DB 無変更。
//
// 設計上の不変条件（corporate-number-candidates 踏襲）:
// - active Owner のみ・select 最小限。
// - 検出は decideRegistryAddressCleanup を再利用。
// - display-level: address が raw-visible でなければ 403（住所を見せられないユーザーには監査させない）。
// - AuditLog detail に Owner.id 配列・住所本文・検出文字列の生値を入れない（件数・type のみ）。
//
// 権限: user_management:read AND owner:read（既存 correction-candidates と同じ）。
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
  decideRegistryAddressCleanup,
  type RegistryStringType,
} from "@/lib/registry-address-cleanup";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const MAX_SCAN = 10_000;

type Level = "hidden" | "masked" | "partial" | "full" | "read" | "edit";
function isRawVisible(level: Level): boolean {
  return level === "full" || level === "read" || level === "edit";
}

type FilterType = "all" | "cleanup" | "manual";
const ALL_TYPES: FilterType[] = ["all", "cleanup", "manual"];
function parseType(input: string | null): FilterType {
  if (input && (ALL_TYPES as string[]).includes(input)) return input as FilterType;
  return "all";
}
function parseLimit(input: string | null): number {
  if (!input) return DEFAULT_LIMIT;
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

interface CandidateRow {
  ownerId: string;
  ownerNameMasked: string | null;
  addressBeforeMasked: string | null;
  addressAfterMasked: string | null;
  action: "cleanup" | "manual";
  detectedTypes: RegistryStringType[];
  removableTypes: RegistryStringType[];
  auditOnlyTypes: RegistryStringType[];
  manualReviewRequired: boolean;
  version: number;
  detailUrl: string;
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

    const cfg = await getOwnerDisplayConfig(session.id, perms);
    const addrLevel = cfg.address as Level;
    const nameLevel = cfg.name as Level;
    if (!isRawVisible(addrLevel)) {
      throw new ApiError(403, "住所の閲覧権限がありません", "FORBIDDEN");
    }

    const { searchParams } = new URL(request.url);
    const type = parseType(searchParams.get("type"));
    const limit = parseLimit(searchParams.get("limit"));
    const cursor = searchParams.get("cursor");

    const owners = await prisma.owner.findMany({
      where: { isArchived: false },
      select: { id: true, name: true, address: true, version: true },
      orderBy: { id: "asc" },
      take: MAX_SCAN + 1,
    });
    const truncated = owners.length > MAX_SCAN;
    const scanned = truncated ? owners.slice(0, MAX_SCAN) : owners;

    const summary = { total: 0, cleanup: 0, manual: 0 };
    const allRows: CandidateRow[] = [];
    for (const o of scanned) {
      const proposal = decideRegistryAddressCleanup({ address: o.address });
      if (proposal.action === "none") continue;
      summary.total++;
      if (proposal.action === "cleanup") summary.cleanup++;
      else summary.manual++;
      allRows.push({
        ownerId: o.id,
        ownerNameMasked: maskValue(o.name, nameLevel),
        addressBeforeMasked: maskValue(o.address, addrLevel),
        addressAfterMasked: maskValue(proposal.cleanedAddress, addrLevel),
        action: proposal.action,
        detectedTypes: proposal.detectedTypes,
        removableTypes: proposal.removableTypes,
        auditOnlyTypes: proposal.auditOnlyTypes,
        manualReviewRequired: proposal.manualReviewRequired,
        version: o.version,
        detailUrl: `/admin/owners/${o.id}`,
      });
    }

    const filtered = allRows.filter((r) => type === "all" || r.action === type);
    const startIndex = cursor ? filtered.findIndex((r) => r.ownerId > cursor) : 0;
    const offset = startIndex < 0 ? filtered.length : startIndex;
    const page = filtered.slice(offset, offset + limit);
    const hasNextPage = offset + limit < filtered.length;
    const nextCursor =
      hasNextPage && page.length > 0 ? page[page.length - 1].ownerId : null;

    await writeAuditLog({
      userId: session.id,
      action: "owner_registry_address_candidates_list",
      detail: { type, resultCount: page.length, summary, hasNextPage, truncated },
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
