// GET /api/admin/owners/correction/corporate-number-candidates
//
// Phase E: 既存 Owner の name / address / note から法人番号候補を検出し、
// Owner.corporateNumber との関係を「missing / same / conflict / multi」に分類して
// dry-run で返す。DB は一切変更しない。
//
// 設計上の不変条件:
// - active Owner のみ対象、select は最小限
// - 検出は detectCorporateNumberInOwnerLike / decideCorporateImport を再利用（PR #31/#34）
// - 国税庁 API lookup は呼ばない（Phase C の手動 UI に誘導）
// - レスポンスは display-level に従ったマスキング済（生 13桁・会社名・住所・note は不要に返さない）
// - AuditLog detail に Owner.id 配列・法人番号生値・会社名・住所・note・候補リスト・
//   検索クエリ生値・rawData 全文を入れない
//
// 権限: user_management:read AND owner:read（既存 correction-candidates と同じ）

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
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import {
  classifyOwnerCorporateCandidate,
  emptyCorporateCandidateSummary,
  tallyCorporateCandidate,
  type CorporateCandidateRow,
  type CorporateCandidateType,
} from "@/lib/owner-corporate-candidates";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
/**
 * 全件 in-memory スキャンの上限。Owner が異常に多い環境で
 * メモリ枯渇を起こさないための安全弁。超過時は truncated=true で返す。
 */
const MAX_SCAN = 10_000;

type FilterType = "all" | "missing" | "conflict" | "multi" | "same";

const ALL_TYPES: FilterType[] = ["all", "missing", "conflict", "multi", "same"];

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
 * 「default 表示は missing / conflict / multi のみ」「same はサブフィルタ時のみ」仕様。
 * filter=all のときは same を除外する。
 */
function matchesFilter(rowType: CorporateCandidateType, filter: FilterType): boolean {
  if (filter === "all") return rowType !== "same";
  return rowType === filter;
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

    const displayConfig = await getOwnerDisplayConfig(session.id);

    // Codex P1 対応: owner_corporate_number=full を必須にする。
    // missing / same / conflict の分類は「raw Owner.corporateNumber と検出候補の exact match」
    // を漏らすため、full 未満の権限ユーザーには候補一覧自体を返さない。
    // - full → 通過、生 corporateNumber を decideCorporateImport に渡してよい
    // - それ以外（edit/read/masked/partial/hidden） → 403
    if (displayConfig.corporateNumber !== "full") {
      throw new ApiError(
        403,
        "法人番号の閲覧権限がありません",
        "FORBIDDEN",
      );
    }

    const { searchParams } = new URL(request.url);
    const type = parseType(searchParams.get("type"));
    const limit = parseLimit(searchParams.get("limit"));
    const cursor = searchParams.get("cursor");

    // 全 active Owner を id 昇順で取得（cursor 安定性のため）。
    // select は最小限。phone/zip/email は dry-run 表示に不要なので取らない。
    const owners = await prisma.owner.findMany({
      where: { isArchived: false },
      select: {
        id: true,
        name: true,
        address: true,
        note: true,
        corporateNumber: true,
        version: true,
      },
      orderBy: { id: "asc" },
      take: MAX_SCAN + 1,
    });

    const truncated = owners.length > MAX_SCAN;
    const scanned = truncated ? owners.slice(0, MAX_SCAN) : owners;

    // 1. 全件分類 → summary 集計
    const allRows: CorporateCandidateRow[] = [];
    const summary = emptyCorporateCandidateSummary();
    for (const o of scanned) {
      const row = classifyOwnerCorporateCandidate(
        {
          id: o.id,
          name: o.name,
          address: o.address,
          note: o.note,
          corporateNumber: o.corporateNumber,
          version: o.version,
        },
        {
          name: displayConfig.name,
          address: displayConfig.address,
          corporateNumber: displayConfig.corporateNumber,
          // Codex P1: owner_note の display-level に従って note 由来の検出を制限する
          note: displayConfig.note,
        },
      );
      if (!row) continue;
      tallyCorporateCandidate(summary, row.type);
      allRows.push(row);
    }

    // 2. type フィルタ
    const filtered = allRows.filter((r) => matchesFilter(r.type, type));

    // 3. cursor 適用（id 昇順前提）
    const startIndex = cursor
      ? filtered.findIndex((r) => r.ownerId > cursor)
      : 0;
    const offset = startIndex < 0 ? filtered.length : startIndex;
    const page = filtered.slice(offset, offset + limit);
    const hasNextPage = offset + limit < filtered.length;
    const nextCursor =
      hasNextPage && page.length > 0 ? page[page.length - 1].ownerId : null;

    // 4. AuditLog（PII を残さない / Owner.id 配列も入れない）
    await writeAuditLog({
      userId: session.id,
      action: "owner_correction_corporate_candidates_list",
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
