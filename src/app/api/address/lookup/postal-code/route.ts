// GET /api/address/lookup/postal-code?zip=1234567
// 郵便番号 → 住所候補。外部 API(日本郵便等)は server-side の lib 経由でのみ呼ぶ。
// APIキーは route/lib(server)でのみ読み、応答には候補(整形済)以外を返さない。

import { NextRequest } from "next/server";
import {
  getApiSession,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import {
  AddressLookupError,
  isValidPostalCode,
  normalizePostalCode,
  lookupAddressByPostalCode,
} from "@/lib/address-lookup";

function mapLookupError(err: AddressLookupError): ApiError {
  if (err.code === "NOT_CONFIGURED") {
    return new ApiError(503, "住所補完APIが設定されていません", "NOT_CONFIGURED");
  }
  // TIMEOUT / NETWORK / AUTH_FAILED / UPSTREAM_4XX / UPSTREAM_5XX / RATE_LIMITED / PARSE_ERROR
  return new ApiError(502, "住所補完APIからの応答取得に失敗しました", "UPSTREAM_ERROR");
}

export async function GET(request: NextRequest) {
  try {
    // 認証必須（未ログインは 401）。外部 API プロキシの匿名濫用・キー消費を防ぐ。
    await getApiSession();

    const zipParam = new URL(request.url).searchParams.get("zip") ?? "";
    if (!isValidPostalCode(zipParam)) {
      throw new ApiError(
        400,
        "郵便番号は7桁で指定してください",
        "INVALID_POSTAL_CODE",
      );
    }
    const normalized = normalizePostalCode(zipParam);

    let candidates;
    try {
      candidates = await lookupAddressByPostalCode(normalized);
    } catch (err) {
      if (err instanceof AddressLookupError) throw mapLookupError(err);
      throw err;
    }

    return apiResponse({ candidates });
  } catch (error) {
    return handleApiError(error);
  }
}
