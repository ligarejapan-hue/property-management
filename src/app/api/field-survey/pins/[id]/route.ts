import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  apiResponse,
  handleApiError,
  parseJsonBody,
  ApiError,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { touchTripActivity } from "@/lib/field-survey-auto-end";
import { patchFieldSurveyPinSchema } from "@/lib/validators";
import { assertPropertyAccessible } from "@/lib/field-survey-property-access";

const SELECT_PIN = {
  id: true,
  sessionId: true,
  staffUserId: true,
  propertyId: true,
  lat: true,
  lng: true,
  accuracy: true,
  pinType: true,
  status: true,
  memo: true,
  createdAt: true,
  updatedAt: true,
} as const;

// ============================================================
// GET /api/field-survey/pins/[id]
// ============================================================
// - field_survey:read 必須。own は read のみで可、他人 pin は read_all/manage 必須。
// - 他人 pin 詳細閲覧時のみ AuditLog (action=field_survey_pin_view)。座標・memo 本文は detail に入れない。

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "field_survey", "read")) {
      throw new ApiError(403, "閲覧権限がありません", "FORBIDDEN");
    }

    const pin = await prisma.fieldSurveyPin.findUnique({
      where: { id },
      select: SELECT_PIN,
    });
    if (!pin) {
      throw new ApiError(404, "pin が見つかりません", "NOT_FOUND");
    }

    const isOwn = pin.staffUserId === session.id;
    const hasReadAll = hasPermission(permissions, "field_survey", "read_all");
    const hasManage = hasPermission(permissions, "field_survey", "manage");
    if (!isOwn && !hasReadAll && !hasManage) {
      throw new ApiError(
        403,
        "他スタッフの pin は閲覧できません",
        "FORBIDDEN",
      );
    }

    if (!isOwn) {
      await writeAuditLog({
        userId: session.id,
        action: "field_survey_pin_view",
        targetTable: "field_survey_pins",
        targetId: pin.id,
        detail: {
          pinId: pin.id,
          ownerStaffUserId: pin.staffUserId,
          hasProperty: pin.propertyId != null,
        },
      });
    }

    return apiResponse({ data: pin });
  } catch (error) {
    return handleApiError(error);
  }
}

// ============================================================
// PATCH /api/field-survey/pins/[id]
// ============================================================
// - field_survey:write 必須。own は更新可、他人 pin 更新は manage 必須。
// - office_staff (read_all のみ) では更新不可。
// - lat/lng は受け付けない (schema.strict() で 422)。
// - propertyId / sessionId の紐付け先には認可を再評価。
// - AuditLog: action=field_survey_pin_update / detail に座標・memo 本文を含めない。

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "field_survey", "write")) {
      throw new ApiError(403, "更新権限がありません", "FORBIDDEN");
    }

    const body = await parseJsonBody(request);
    const patch = patchFieldSurveyPinSchema.parse(body);

    const existing = await prisma.fieldSurveyPin.findUnique({
      where: { id },
      select: {
        id: true,
        staffUserId: true,
        sessionId: true,
        propertyId: true,
        pinType: true,
        status: true,
        memo: true,
      },
    });
    if (!existing) {
      throw new ApiError(404, "pin が見つかりません", "NOT_FOUND");
    }

    const isOwn = existing.staffUserId === session.id;
    const hasManage = hasPermission(permissions, "field_survey", "manage");
    if (!isOwn && !hasManage) {
      throw new ApiError(
        403,
        "他スタッフの pin は更新できません",
        "FORBIDDEN",
      );
    }

    // 巡回紐づけの「解除」は巡回外ピンを作るのと同じ結果になる (巡回履歴から
    // 外れ、移動軌跡と対応しなくなる)。POST の quick_capture ゲートが
    // 「巡回中に作ってから解除する」で迂回されないよう、同じ権限を要求する。
    if (
      patch.sessionId === null &&
      existing.sessionId !== null &&
      !hasPermission(permissions, "field_survey", "quick_capture")
    ) {
      throw new ApiError(
        403,
        "巡回の紐づけを外す権限がありません",
        "QUICK_CAPTURE_FORBIDDEN",
      );
    }

    // 「巡回に紐づかない pin は必ず物件化候補」の不変条件を更新側でも守る。
    // 巡回外 pin は巡回履歴に出ないため、候補以外にすると完成待ち一覧
    // (candidate / open / 未物件化のみ) からも外れ、どの一覧にも出なくなる。
    // 作成時 (POST) だけ守っても、①巡回外 pin の種類変更 ②候補以外 pin の
    // 巡回紐づけ解除 の 2 経路で同じ状態を作れるため、更新後の姿で判定する。
    // 完成待ち一覧から外したいだけなら「候補から外す」(status=archived) を使う。
    const nextSessionId =
      patch.sessionId !== undefined ? patch.sessionId : existing.sessionId;
    const nextPinType = patch.pinType ?? existing.pinType;
    // 判定するのは「この更新が違反を作る/維持する場合」だけにする。
    // 本機能の前(または API 直叩き・session 削除の SetNull)で既に
    // 「巡回なし × 候補以外」の行が存在し得る環境では、メモや状態だけを直す
    // 無関係な PATCH まで 422 で塞ぐと編集不能になる (@codex #328 R4)。
    // pinType / sessionId を触らない更新は既存状態のまま通し、種類を candidate に
    // 直す更新 (違反の解消) も通す。
    const touchesInvariantFields =
      patch.pinType !== undefined || patch.sessionId !== undefined;
    if (
      nextSessionId === null &&
      nextPinType !== "candidate" &&
      touchesInvariantFields
    ) {
      throw new ApiError(
        422,
        "巡回に紐づかないピンは「物件化候補」のみです。種類を変えるには巡回に紐づけてください。",
        "QUICK_CAPTURE_PIN_TYPE",
      );
    }

    // sessionId 変更時の認可。
    // pin owner と session owner の一致を必須にする (Codex P1-2)。
    // manage で他人 pin を更新するケースでも、pin 所有者と一致する session
    // にのみ紐付け可能。pin と session の所有者が食い違うデータを作らない。
    // 解除 (patch.sessionId === null) は上のゲートを通過したものだけ許可。
    if (patch.sessionId !== undefined && patch.sessionId !== null) {
      const sess = await prisma.fieldSurveySession.findUnique({
        where: { id: patch.sessionId },
        select: { staffUserId: true, status: true },
      });
      if (!sess) {
        throw new ApiError(404, "session が見つかりません", "SESSION_NOT_FOUND");
      }
      if (sess.staffUserId !== existing.staffUserId) {
        throw new ApiError(
          409,
          "pin 所有者と session 所有者が一致しません",
          "SESSION_OWNER_MISMATCH",
        );
      }
      if (sess.status !== "active") {
        throw new ApiError(
          409,
          "active 状態でない session には紐付けられません",
          "INVALID_STATE",
        );
      }
    }

    // propertyId 変更時の認可
    if (patch.propertyId !== undefined && patch.propertyId !== null) {
      await assertPropertyAccessible(patch.propertyId, session, permissions);
    }

    // 「巡回外は候補のみ」の判定は上で読んだ行に基づく = check-then-write。
    // 同一 pin に対する 2 本の PATCH ({pinType:"blocked"} と {sessionId:null}) が
    // 並行すると、双方が同じ旧行を読んで個別に判定を通り、それぞれ別フィールドだけ
    // 更新するため最終行が「巡回なし × 候補以外」= 防ごうとした孤児状態になる
    // (@codex #328 R2 P1)。判定の根拠列 (sessionId / pinType) を条件に含めた
    // updateMany で CAS し、0 件なら 409 にして再試行させる。
    // CAS と読み直しは同一 transaction 内で行う。updateMany が行ロックを取るため、
    // 続く findUniqueOrThrow は「自分の更新後の姿」を読み、並行 PATCH は
    // commit まで待たされる。分離すると、CAS 述語に含まれない列だけを変える
    // 2 本 (例: status closed と archived) が双方成功し、読み直しで相手の結果を
    // 拾って応答と AuditLog の statusAfter が食い違う (@codex #328 R3 P2)。
    const updated = await prisma.$transaction(async (tx) => {
      const casResult = await tx.fieldSurveyPin.updateMany({
        where: {
          id,
          sessionId: existing.sessionId,
          pinType: existing.pinType,
        },
        data: {
          ...(patch.pinType !== undefined && { pinType: patch.pinType }),
          ...(patch.status !== undefined && { status: patch.status }),
          ...(patch.memo !== undefined && { memo: patch.memo }),
          ...(patch.propertyId !== undefined && {
            propertyId: patch.propertyId,
          }),
          ...(patch.sessionId !== undefined && { sessionId: patch.sessionId }),
        },
      });
      if (casResult.count === 0) return null;
      // ⚠session 紐付けは同一 tx 内の条件付き touch で確定させる（総点検P3）。
      // 上の active 検証は tx の外の check-then-write で、検証と書込のすき間に
      // session が終了すると**終了済み巡回へピンが紐づく**。POST /pins と同じ
      // 「touch の 0 行 = 並行終了の合図 → 409 で rollback」に揃える
      // （touch は B-7 の最終活動時刻の更新も兼ねる）。
      if (patch.sessionId !== undefined && patch.sessionId !== null) {
        const touched = await tx.fieldSurveySession.updateMany({
          where: { id: patch.sessionId, status: "active" },
          data: { updatedAt: new Date() },
        });
        if (touched.count === 0) {
          throw new ApiError(
            409,
            "active 状態でない session には紐付けられません",
            "INVALID_STATE",
          );
        }
      }
      // ⚠**ピンの編集も巡回の活動として数える**(@codex #356 P2)。上の touch は
      // 「巡回の紐付けを変えたとき」しか走らないため、メモや種類だけを直し続けて
      // いる巡回が無操作扱いになり、自動終了(1時間)で切られてしまう。
      // best-effort: 終了済みの巡回のピンを後から直すのは正常な操作なので throw しない。
      await touchTripActivity(tx, nextSessionId);
      return tx.fieldSurveyPin.findUniqueOrThrow({
        where: { id },
        select: SELECT_PIN,
      });
    });
    if (updated === null) {
      throw new ApiError(
        409,
        "ほかの操作と競合しました。画面を更新してからやり直してください。",
        "CONCURRENT_UPDATE",
      );
    }

    const changedFields: string[] = [];
    if (patch.pinType !== undefined && patch.pinType !== existing.pinType) {
      changedFields.push("pinType");
    }
    if (patch.status !== undefined && patch.status !== existing.status) {
      changedFields.push("status");
    }
    // memo は指定があっても既存値と同一なら no-op (AuditLog の信頼性確保 / Codex P2)。
    // null / 空文字 / 通常文字列は strict equality でそのまま比較する。
    if (patch.memo !== undefined && patch.memo !== existing.memo) {
      changedFields.push("memo");
    }
    if (
      patch.propertyId !== undefined &&
      patch.propertyId !== existing.propertyId
    ) {
      changedFields.push("propertyId");
    }
    if (
      patch.sessionId !== undefined &&
      patch.sessionId !== existing.sessionId
    ) {
      changedFields.push("sessionId");
    }

    if (changedFields.length > 0) {
      await writeAuditLog({
        userId: session.id,
        action: "field_survey_pin_update",
        targetTable: "field_survey_pins",
        targetId: updated.id,
        detail: {
          pinId: updated.id,
          changedFields,
          ...(changedFields.includes("status") && {
            statusBefore: existing.status,
            statusAfter: updated.status,
          }),
        },
      });
    }

    return apiResponse({ data: updated });
  } catch (error) {
    return handleApiError(error);
  }
}

// ============================================================
// DELETE /api/field-survey/pins/[id]
// ============================================================
// Phase 1-I: 調査ピンの論理削除。物理削除はせず status=archived にする。
// - own pin は field_survey:write で削除可。他人 pin は field_survey:manage 必須。
// - read_all だけでは削除不可。
// - FieldSurveyPinPhoto は消さない / storage.delete もしない。
// - archived 済を再削除しても安全 (updateMany の冪等な status 遷移で 0 行 = 既に archived)。
// - AuditLog: action=field_survey_pin_delete。detail に座標 / memo / 写真 / PII を含めない。

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    const hasWrite = hasPermission(permissions, "field_survey", "write");
    const hasManage = hasPermission(permissions, "field_survey", "manage");
    if (!hasWrite && !hasManage) {
      throw new ApiError(403, "このピンを削除する権限がありません", "FORBIDDEN");
    }

    const existing = await prisma.fieldSurveyPin.findUnique({
      where: { id },
      // sessionId は巡回の活動更新に使う (@codex #356 P2)。
      select: { id: true, staffUserId: true, status: true, sessionId: true },
    });
    if (!existing) {
      throw new ApiError(404, "pin が見つかりません", "NOT_FOUND");
    }

    const isOwn = existing.staffUserId === session.id;
    // own は write、他人は manage 必須 (read_all だけでは不可)。
    if (!hasManage && !(isOwn && hasWrite)) {
      throw new ApiError(403, "このピンを削除する権限がありません", "FORBIDDEN");
    }

    // 冪等な status 遷移。既に archived なら 0 行更新 = 再削除でも安全に成功扱い。
    // ⚠**削除と心拍を同じ transaction で行う**(@codex #356 P2)。別々だと、
    // 削除が commit してから心拍が走るまでの隙間に見回りが入り込み、
    // 「本当に操作しているのに終了させられる」(心拍は 0 行更新で黙って終わる)。
    // 同一 tx なら、心拍が勝てば見回りの CAS が外れ、見回りが勝てば削除の前に終わる。
    const result = await prisma.$transaction(async (tx) => {
      const r = await tx.fieldSurveyPin.updateMany({
        where: { id, status: { not: "archived" } },
        data: { status: "archived" },
      });
      if (r.count > 0) await touchTripActivity(tx, existing.sessionId);
      return r;
    });

    // 実際に open/closed → archived へ遷移したときのみ監査ログを残す。
    if (result.count > 0) {
      await writeAuditLog({
        userId: session.id,
        action: "field_survey_pin_delete",
        targetTable: "field_survey_pins",
        targetId: id,
        detail: {
          pinId: id,
          targetOwner: isOwn ? "own" : "other",
          viaManage: !isOwn && hasManage,
        },
      });
    }

    return apiResponse({ data: { id, status: "archived" } });
  } catch (error) {
    return handleApiError(error);
  }
}
