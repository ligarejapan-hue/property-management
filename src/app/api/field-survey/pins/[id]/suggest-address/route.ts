// POST /api/field-survey/pins/:id/suggest-address
// 調査ピンの座標から住所（**住居表示**）を提案する。物件化フォームの「住所を自動入力」用。
// 第2弾: 取込済みの街区データ(国土交通省・ローカルDB)があれば**番まで**
// (precision:"block")、無ければ国土地理院で**町丁目まで**(precision:"town")。
//
// - ⚠**POST であること自体が防御**（Codex R7 P2）: この操作は「保護対象の座標を
//   外部（国土地理院）へ送信する」副作用を持つ。GET だと SameSite=Lax cookie が
//   cross-site のトップレベル遷移に同乗し、リンクを踏むだけで本人の明示操作なしに
//   送信が発動し得る。本リポジトリの CSRF 姿勢（Lax が cross-site POST を遮る）に
//   合わせ、読み取り風の操作でも副作用があるので POST に固定する。
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
  isReverseGeocodeConfigured,
  reverseGeocode,
} from "@/lib/reverse-geocode";
import {
  findNearestBlock,
  LOT_PREFILL_MAX_DISTANCE_M,
} from "@/lib/address-blocks/lookup";

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

export async function POST(
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
      select: {
        id: true,
        staffUserId: true,
        lat: true,
        lng: true,
        pinType: true,
        status: true,
        propertyId: true,
      },
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

    // 物件化できる状態のピンに限定する（convert-to-property と同一の状態チェック・
    // Codex R8 P2）。古い modal や直接リクエストで、変換不能なピン（候補外/対応済み/
    // アーカイブ/物件化済み）の座標を外部送信しない。監査・外部呼び出しより前に弾く。
    if (pin.pinType !== "candidate") {
      throw new ApiError(422, "物件化候補ではないため住所を提案できません", "NOT_CANDIDATE");
    }
    if (pin.status !== "open") {
      throw new ApiError(409, "未対応の候補ピンのみ住所を提案できます", "PIN_NOT_OPEN");
    }
    if (pin.propertyId) {
      throw new ApiError(409, "この調査ピンは既に物件化済みです", "ALREADY_CONVERTED");
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

    // 機能全体の休眠ゲート(env 未設定なら 503)。ローカル照合(外部送信ゼロ)も
    // このゲートの内側=「機能を有効化するまで一切動かない」を単純に保つ。
    if (!isReverseGeocodeConfigured()) {
      throw mapError(new ReverseGeocodeError("NOT_CONFIGURED"));
    }

    // 第2弾: まず取込済みの街区データ(国土交通省)で「番」まで引く(ローカル完結・
    // 外部送信ゼロ)。データ未取込の地域・最近傍150m超のみ、従来どおり国土地理院
    // (町丁目まで・座標のみ送信)へフォールバックする。
    const block = await findNearestBlock(lat, lng);
    if (block) {
      return apiResponse({
        result: {
          found: true,
          address: block.address,
          town: block.town,
          precision: "block",
          // 住居表示未実施の地域では block 値=**地番そのもの**(Codex R3 P2)。
          // 捨てると謄本の所在検索に使える値を失うため、地番欄の初期値候補として
          // 返す(UI 側は空欄のときだけ入れ、要確認の案内を出す)。
          // ⚠誤った地番は謄本の誤請求につながるため、点のほぼ真上(50m以内)の
          // ときだけ提案する(Codex R7 P2: 境界越しの誤マッチ対策)。
          ...(block.isResidential ||
          block.distanceM > LOT_PREFILL_MAX_DISTANCE_M
            ? {}
            : { lotNumber: block.block }),
        },
      });
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
