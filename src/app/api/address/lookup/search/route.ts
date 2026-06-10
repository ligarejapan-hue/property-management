// GET /api/address/lookup/search?address=東京都...
// 住所文字列 → 郵便番号付き候補。外部 API は server-side の lib 経由でのみ呼ぶ。
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
  normalizeAddress,
  searchAddressByText,
} from "@/lib/address-lookup";

function mapLookupError(err: AddressLookupError): ApiError {
  if (err.code === "NOT_CONFIGURED") {
    return new ApiError(503, "住所補完APIが設定されていません", "NOT_CONFIGURED");
  }
  return new ApiError(502, "住所補完APIからの応答取得に失敗しました", "UPSTREAM_ERROR");
}

export async function GET(request: NextRequest) {
  try {
    // 認証必須（未ログインは 401）。
    await getApiSession();

    const addressParam = new URL(request.url).searchParams.get("address") ?? "";
    const normalized = normalizeAddress(addressParam);
    if (normalized.length === 0) {
      throw new ApiError(400, "住所を指定してください", "INVALID_ADDRESS");
    }

    let candidates;
    try {
      candidates = await searchAddressByText(normalized);
    } catch (err) {
      if (err instanceof AddressLookupError) throw mapLookupError(err);
      throw err;
    }

    return apiResponse({ candidates });
  } catch (error) {
    return handleApiError(error);
  }
}
