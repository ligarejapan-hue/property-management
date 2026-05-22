// POST /api/owners/[id]/corporate-lookup
// 法人番号 lookup preview。Owner 行は更新しない。Phase B のみ。
//
// 仕様詳細は src/lib/corporate-lookup/ と CLAUDE.md / AGENTS.md 参照。
// AuditLog detail には法人番号 / 会社名 / 所在地 / フリガナ / postCode / raw XML を入れない。

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { hasPermission, hasExplicitWritePerm } from "@/lib/permissions";
import { normalizeCorporateNumber } from "@/lib/corporate-number";
import { CorporateLookupError, lookupCorporateNumber } from "@/lib/corporate-lookup";

interface RequestBody {
  corporateNumber?: unknown;
}

function mapLookupErrorToApi(err: CorporateLookupError): ApiError {
  switch (err.code) {
    case "NOT_CONFIGURED":
      return new ApiError(503, "法人番号APIが設定されていません", "NOT_CONFIGURED");
    case "RATE_LIMITED":
      return new ApiError(429, "国税庁APIのレート制限に達しました", "RATE_LIMITED");
    case "TIMEOUT":
    case "NETWORK":
    case "UPSTREAM_4XX":
    case "UPSTREAM_5XX":
    case "PARSE_ERROR":
    default:
      return new ApiError(502, "国税庁APIからの応答取得に失敗しました", "UPSTREAM_ERROR");
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let auditCode: string | null = null;
  let auditHttpStatus: number | null = null;
  let auditUserId: string | null = null;
  let auditOwnerId: string | null = null;

  try {
    const { id } = await params;
    auditOwnerId = id;
    const session = await getApiSession();
    auditUserId = session.id;
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "owner", "read")) {
      throw new ApiError(403, "所有者閲覧の権限がありません", "FORBIDDEN");
    }
    if (!hasExplicitWritePerm(perms, "owner_corporate_number")) {
      throw new ApiError(
        403,
        "法人番号を扱う権限がありません",
        "FORBIDDEN",
      );
    }

    const body = (await request.json().catch(() => ({}))) as RequestBody;
    const normalized = normalizeCorporateNumber(
      typeof body.corporateNumber === "string" ? body.corporateNumber : null,
    );
    if (!normalized) {
      throw new ApiError(
        422,
        "法人番号は13桁の数字で指定してください",
        "VALIDATION_ERROR",
      );
    }

    // Owner 実在 + archived チェック。Owner.name / address 等は読まない（必要なし）。
    const owner = await prisma.owner.findUnique({
      where: { id },
      select: { id: true, isArchived: true },
    });
    if (!owner || owner.isArchived) {
      throw new ApiError(404, "所有者が見つかりません", "NOT_FOUND");
    }

    let result;
    try {
      result = await lookupCorporateNumber(normalized);
    } catch (err) {
      if (err instanceof CorporateLookupError) {
        throw mapLookupErrorToApi(err);
      }
      throw err;
    }

    auditCode = result.found ? (result.isClosed ? "found_closed" : "found") : "not_found";
    auditHttpStatus = 200;

    // AuditLog の detail には生値・会社名・住所等を一切入れない。
    await writeAuditLog({
      userId: session.id,
      action: "owner_corporate_lookup",
      targetTable: "owners",
      targetId: id,
      detail: {
        found: result.found,
        isClosed: result.isClosed,
        source: result.source,
        result: auditCode,
        httpStatus: auditHttpStatus,
      },
    });

    return apiResponse({
      lookup: {
        found: result.found,
        isClosed: result.isClosed,
        closeDate: result.closeDate,
        closeCause: result.closeCause,
        record: result.record,
        fetchedAt: result.fetchedAt,
        source: result.source,
      },
    });
  } catch (error) {
    // エラー時も AuditLog を残す（route 内で session/owner 解決済の場合のみ）。
    // detail には生値を残さない。
    if (auditUserId && auditOwnerId && error instanceof ApiError) {
      auditCode = error.code;
      auditHttpStatus = error.status;
      try {
        await writeAuditLog({
          userId: auditUserId,
          action: "owner_corporate_lookup",
          targetTable: "owners",
          targetId: auditOwnerId,
          detail: {
            found: false,
            isClosed: false,
            source: null,
            result: auditCode,
            httpStatus: auditHttpStatus,
          },
        });
      } catch {
        // audit 失敗は本処理を壊さない（writeAuditLog 自体も try/catch するが二重防御）
      }
    }
    return handleApiError(error);
  }
}
