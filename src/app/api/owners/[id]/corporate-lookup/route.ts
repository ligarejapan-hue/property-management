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
  getOwnerDisplayConfig,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { hasPermission, hasExplicitWritePerm } from "@/lib/permissions";
import {
  classifyCorporateIdentifier,
  calculateCorporateNumberFromCompanyNumber,
  normalizeCorporateIdentifier,
  type CorporateIdentifierKind,
} from "@/lib/corporate-number";
import { CorporateLookupError, lookupCorporateNumber } from "@/lib/corporate-lookup";
import {
  assessCorporateLookupConflict,
  type CorporateLookupConflict,
} from "@/lib/corporate-lookup/conflict";
import { isRawVisible } from "@/lib/owner-corporate-candidates";

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
  let auditInputKind: CorporateIdentifierKind | null = null;
  let auditConflict: CorporateLookupConflict | null = null;

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
    // 12桁(会社法人等番号) / 13桁(法人番号) を受け付け、13桁に解決する(server を正)。
    //  - 12桁 → チェックデジット付与で13桁算出
    //  - 13桁(CD正) → そのまま採用
    //  - それ以外(13桁CD不正/11/14桁/数字以外) → 422
    const rawInput =
      typeof body.corporateNumber === "string" ? body.corporateNumber : null;
    const inputKind = classifyCorporateIdentifier(rawInput);
    auditInputKind = inputKind;
    const resolved =
      inputKind === "company_corporate_number_12"
        ? calculateCorporateNumberFromCompanyNumber(rawInput)
        : inputKind === "corporate_number_13"
          ? normalizeCorporateIdentifier(rawInput)
          : null;
    if (!resolved) {
      throw new ApiError(
        422,
        "12桁の会社法人等番号、または13桁の法人番号(チェックデジット正)で指定してください",
        "VALIDATION_ERROR",
      );
    }

    // Owner 実在 + archived チェック。conflict 判定のため name/address も読む
    // (返すのは分類フラグのみ。生値はログ/audit/エラーに出さない)。
    const owner = await prisma.owner.findUnique({
      where: { id },
      select: { id: true, isArchived: true, name: true, address: true },
    });
    if (!owner || owner.isArchived) {
      throw new ApiError(404, "所有者が見つかりません", "NOT_FOUND");
    }

    let result;
    try {
      result = await lookupCorporateNumber(resolved);
    } catch (err) {
      if (err instanceof CorporateLookupError) {
        throw mapLookupErrorToApi(err);
      }
      throw err;
    }

    // conflict 判定: 国税庁結果の名称/所在地 vs 既存 Owner 名/住所。
    // field-level 可視性を尊重し、raw-visible でない項目は null(=その信号 unknown)で渡す
    // (一括反映の field-visibility と同型。マスク項目から不一致を推測させない)。
    let conflict: CorporateLookupConflict = "unknown";
    if (result.found && result.record) {
      const displayConfig = await getOwnerDisplayConfig(session.id, perms);
      conflict = assessCorporateLookupConflict(
        {
          name: isRawVisible(displayConfig.name) ? owner.name : null,
          address: isRawVisible(displayConfig.address) ? owner.address : null,
        },
        { name: result.record.name, address: result.record.address },
      );
    }
    auditConflict = conflict;

    auditCode = result.found ? (result.isClosed ? "found_closed" : "found") : "not_found";
    auditHttpStatus = 200;

    // AuditLog の detail には生値・会社名・住所等を一切入れない(分類フラグのみ)。
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
        inputKind,
        conflict,
      },
    });

    return apiResponse({
      inputKind,
      resolvedCorporateNumber13: resolved,
      conflict,
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
            inputKind: auditInputKind,
            conflict: auditConflict,
          },
        });
      } catch {
        // audit 失敗は本処理を壊さない（writeAuditLog 自体も try/catch するが二重防御）
      }
    }
    return handleApiError(error);
  }
}
