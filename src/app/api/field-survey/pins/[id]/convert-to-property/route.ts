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
      select: { id: true, staffUserId: true, propertyId: true, lat: true, lng: true, status: true },
    });
    if (!pin) {
      throw new ApiError(404, "調査ピンが見つかりません", "NOT_FOUND");
    }

    const isOwn = pin.staffUserId === session.id;
    const hasManage = hasPermission(permissions, "field_survey", "manage");
    if (!isOwn && !hasManage) {
      throw new ApiError(403, "この調査ピンを物件化する権限がありません", "FORBIDDEN");
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

    const property = await prisma.$transaction(async (tx) => {
      const created = await tx.property.create({ data, select: { id: true } });
      await tx.fieldSurveyPin.update({
        where: { id: pin.id },
        data: { propertyId: created.id, status: "closed" },
      });
      return created;
    });

    await writeAuditLog({
      userId: session.id,
      action: "create",
      targetTable: "properties",
      targetId: property.id,
      detail: { propertyType: input.propertyType, address: input.address, fromPin: pin.id },
    });

    return apiResponse({ id: property.id }, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
