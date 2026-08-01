// GET /api/field-survey/pins/:id/suggest-address
// 調査ピンの座標から住所（**住居表示・町丁目まで**）を提案する。物件化フォームの
// 「住所を自動入力」用。
//
// - ⚠座標は**クライアントへ渡さず**、server がピンから読んで逆ジオコーディングする。
//   完成待ち一覧（candidates）は意図的に座標を返さない設計のため、この機能のために
//   座標の露出面を広げない。返すのは組み立て済みの住所（町丁目まで）のみ。
// - 認可は物件化（convert-to-property）と同じ: property:write + field_survey:read +
//   （自分の pin OR field_survey:read_all / manage）。物件化できる人にだけ提案する。
// - 外部 API（国土地理院・無料・キー不要）は server-side の lib 経由でのみ呼ぶ。
//   外部へ送るのは**座標のみ**（氏名・住所等は送らない。座標も保護対象の位置情報＝
//   利用者の明示ボタン操作時のみ送信し、UI に送信先[国土地理院]を明示する）。
//   env 未設定なら 503 休眠。
// - **地番（lotNumber）は対象外**（座標から地番は引けない）。番・号も返らない仕様
//   （無料APIの限界）＝利用者が確認して追記する前提（UI 側に明記）。
// - 監査ログ: **他スタッフの pin への実行時のみ** location route と同じ
//   `field_survey_pin_view`（ID のみ・座標/住所は detail に入れない）を記録する。
//   位置情報由来データへの cross-staff アクセス経路として既存の追跡と揃える（Codex P2）。

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import {
  ReverseGeocodeError,
  isPlausibleJapanCoordinate,
  reverseGeocode,
} from "@/lib/reverse-geocode";

function mapError(err: ReverseGeocodeError): ApiError {
  if (err.code === "NOT_CONFIGURED") {
    return new ApiError(
      503,
      "住所の自動取得は設定されていません",
      "NOT_CONFIGURED",
    );
  }
  // TIMEOUT / NETWORK / UPSTREAM_ERROR / PARSE_ERROR
  return new ApiError(
    502,
    "住所の自動取得に失敗しました。時間をおいて再度お試しください",
    "UPSTREAM_ERROR",
  );
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    // 物件化と同じゲート（物件化できる人にだけ住所を提案する）。
    if (!hasPermission(permissions, "property", "write")) {
      throw new ApiError(403, "物件登録の権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(permissions, "field_survey", "read")) {
      throw new ApiError(403, "現地調査の閲覧権限がありません", "FORBIDDEN");
    }

    const pin = await prisma.fieldSurveyPin.findUnique({
      where: { id },
      select: { id: true, staffUserId: true, lat: true, lng: true },
    });
    if (!pin) {
      throw new ApiError(404, "調査ピンが見つかりません", "NOT_FOUND");
    }
    const isOwn = pin.staffUserId === session.id;
    const visible =
      isOwn ||
      hasPermission(permissions, "field_survey", "read_all") ||
      hasPermission(permissions, "field_survey", "manage");
    if (!visible) {
      throw new ApiError(
        403,
        "この調査ピンにアクセスする権限がありません",
        "FORBIDDEN",
      );
    }

    if (!isOwn) {
      // 他スタッフ pin の位置由来データ取得 = location route と同じ追跡を残す（Codex P2）。
      await writeAuditLog({
        userId: session.id,
        action: "field_survey_pin_view",
        targetTable: "field_survey_pins",
        targetId: pin.id,
        // 座標・住所は監査 detail に入れない (id / owner のみ)。
        detail: { pinId: pin.id, ownerStaffUserId: pin.staffUserId },
      });
    }

    // Prisma の Decimal を number に（既存 route と同じ Number() 変換）。
    const lat = Number(pin.lat);
    const lng = Number(pin.lng);
    if (!isPlausibleJapanCoordinate(lat, lng)) {
      // ピンの座標が壊れている（通常起き得ない）。上流へ無駄打ちしない。
      return apiResponse({ result: { found: false } });
    }

    try {
      const result = await reverseGeocode(lat, lng);
      // found:false = 海上・国外・変換表に無い等（エラーではなく「該当なし」）。
      return apiResponse({ result });
    } catch (err) {
      if (err instanceof ReverseGeocodeError) throw mapError(err);
      throw err;
    }
  } catch (error) {
    return handleApiError(error);
  }
}
