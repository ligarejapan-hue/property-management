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
import { convertPinToPropertySchema } from "@/lib/validators";
import { buildPropertyDataFromPin } from "@/lib/field-survey-convert";

// ============================================================
// POST /api/field-survey/pins/[id]/convert-to-property
// ============================================================
// 「物件化候補」ピンを物件にする。
// - 認可 = property:write(物件作成が本質)。他人 pin は field_survey:manage が
//   無いと不可(pin 書込みと同一スコープ = 兄弟 PATCH と揃える)。
// - property 作成 + pin(propertyId / status=closed)を $transaction で原子的に。
//   途中失敗で中途半端な物件/未リンク pin を残さない。
// - 既に propertyId があれば 409(二重物件化ガード)。
// - GPS はピンから継承(入力では受け取らない)。
// - 監査 detail に座標・memo を入れない(非PII・既存 property create と同一 allowlist)。

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "property", "write")) {
      throw new ApiError(403, "物件登録の権限がありません", "FORBIDDEN");
    }

    const pin = await prisma.fieldSurveyPin.findUnique({
      where: { id },
      select: { id: true, staffUserId: true, propertyId: true, pinType: true, lat: true, lng: true, status: true },
    });
    if (!pin) {
      throw new ApiError(404, "調査ピンが見つかりません", "NOT_FOUND");
    }

    // 変換は「一覧で見える候補」に対して行える＝完成待ち一覧の可視スコープに合わせる。
    // 自分の pin か、field_survey:read_all / manage を持つ場合(他スタッフの候補も
    // 一覧で拾える office_staff 等)に許可。物件作成の property:write は上で必須。
    const isOwn = pin.staffUserId === session.id;
    const canSeeOthers =
      hasPermission(permissions, "field_survey", "read_all") ||
      hasPermission(permissions, "field_survey", "manage");
    if (!isOwn && !canSeeOthers) {
      throw new ApiError(403, "この調査ピンを物件化する権限がありません", "FORBIDDEN");
    }

    // UI と同じく「物件化候補」ピンのみ対象(サーバー側でも強制)。
    if (pin.pinType !== "candidate") {
      throw new ApiError(422, "物件化候補ではないため物件化できません", "NOT_CANDIDATE");
    }

    // アーカイブ(論理削除)済みピンは物件化しない。削除相当のピンを物件へ復活させない。
    if (pin.status === "archived") {
      throw new ApiError(409, "アーカイブ済みの調査ピンは物件化できません", "PIN_ARCHIVED");
    }

    if (pin.propertyId) {
      throw new ApiError(409, "この調査ピンは既に物件化済みです", "ALREADY_CONVERTED");
    }

    const body = await parseJsonBody(request);
    const input = convertPinToPropertySchema.parse(body);
    const data = buildPropertyDataFromPin(
      input,
      { lat: Number(pin.lat), lng: Number(pin.lng) },
      session.id,
    );

    // property 作成 + pin リンクを原子的に。リンクは propertyId=null 条件付き
    // (updateMany の count)にして、同一 pin の同時変換による二重物件化を防ぐ。
    const property = await prisma.$transaction(async (tx) => {
      const created = await tx.property.create({ data, select: { id: true } });
      const linked = await tx.fieldSurveyPin.updateMany({
        // 前チェック後〜書込みの間の並行編集(アーカイブ / 種別変更 / 別変換)にも耐える:
        // 候補 × 未アーカイブ × 未紐付け が書込み時点でも真のときだけ紐付ける。
        where: { id: pin.id, propertyId: null, pinType: "candidate", status: { not: "archived" } },
        data: { propertyId: created.id, status: "closed" },
      });
      if (linked.count === 0) {
        throw new ApiError(409, "この調査ピンは既に物件化済みです", "ALREADY_CONVERTED");
      }
      return created;
    });

    await writeAuditLog({
      userId: session.id,
      action: "create",
      targetTable: "properties",
      targetId: property.id,
      detail: { propertyType: input.propertyType, fromPin: pin.id },
    });

    return apiResponse({ id: property.id }, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
