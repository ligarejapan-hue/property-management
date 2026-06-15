// POST /api/corporate/lookup
// 法人番号 → 法人名・本店所在地（NTA 法人番号 Web-API）。住所補完 /api/address/lookup/* と同型の
// server-side proxy。外部 API は server-side lib（@/lib/corporate-lookup）経由でのみ呼ぶ。
//
// 設計（住所補完ミラー）:
//  - 認証必須（未ログインは 401）。外部 API プロキシの匿名濫用・NTA キー消費を防ぐ。
//  - 入力（法人番号）は URL に載せず POST body で受ける（PR-2b の教訓: 識別子を browser history /
//    proxy / access log に残さない）。13桁へ正規化できなければ 400。
//  - APIキー（CORPORATE_NUMBER_API_APP_ID）は route/lib（server）でのみ読み、応答には候補
//    （CorporateLookupRecord）以外を返さない。raw XML / appId / secret は返さない・ログに出さない。
//  - 候補は配列で返す（mirror: address-lookup の candidates[]）。0件は []、廃止法人も record を含める。
//  - 既存 orchestrator（lookupCorporateNumber）と env（CORPORATE_NUMBER_API_*）を再利用する
//    （owner-scoped /api/owners/[id]/corporate-lookup とは別の汎用エンドポイント。DB/AuditLog 非接触）。

import { NextRequest } from "next/server";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission, hasExplicitWritePerm } from "@/lib/permissions";
import { normalizeCorporateNumber } from "@/lib/corporate-number";
import {
  CorporateLookupError,
  lookupCorporateNumber,
  type CorporateLookupRecord,
} from "@/lib/corporate-lookup";

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

export async function POST(request: NextRequest) {
  try {
    // 認証必須（未ログインは getApiSession が 401 を throw）。
    const session = await getApiSession();

    // 認可: owner-scoped /api/owners/[id]/corporate-lookup と同一ゲート。
    // owner:read + 明示 owner_corporate_number(full/edit) を要求する。これが無いと、
    // 法人番号フィールドが hidden のユーザーが本汎用エンドポイント経由で任意の13桁を投げ、
    // server APIキーで法人番号・法人名・所在地を取得できてしまう（既存 owner-scoped 制御の
    // API側バイパス）。lookup 実行前に同じ制御を必ず通す（Codex P1）。
    const perms = await getUserPermissions(session.id);
    if (!hasPermission(perms, "owner", "read")) {
      throw new ApiError(403, "所有者閲覧の権限がありません", "FORBIDDEN");
    }
    if (!hasExplicitWritePerm(perms, "owner_corporate_number")) {
      throw new ApiError(403, "法人番号を扱う権限がありません", "FORBIDDEN");
    }

    // JSON `null` や非オブジェクト body でも安全に 400 にする。body.corporateNumber を
    // 参照する前にオブジェクトであることを保証する（`null` を直接読むと TypeError → 500 に
    // なるため。parse 失敗だけでなく parsed===null / プリミティブも空扱いにする・Codex P2）。
    const parsed = (await request.json().catch(() => null)) as unknown;
    const body: RequestBody =
      parsed !== null && typeof parsed === "object"
        ? (parsed as RequestBody)
        : {};
    const normalized = normalizeCorporateNumber(
      typeof body.corporateNumber === "string" ? body.corporateNumber : null,
    );
    if (!normalized) {
      throw new ApiError(
        400,
        "法人番号は13桁の数字で指定してください",
        "INVALID_CORPORATE_NUMBER",
      );
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

    // mirror: address-lookup の candidates[]。0件は []、廃止法人（found=true）も record を含める。
    const candidates: CorporateLookupRecord[] =
      result.found && result.record ? [result.record] : [];

    return apiResponse({ candidates });
  } catch (error) {
    return handleApiError(error);
  }
}
