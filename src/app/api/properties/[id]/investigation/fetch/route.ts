import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  handleApiError,
  apiResponse,
  ApiError,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { hasPermission } from "@/lib/permissions";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { runAndUpsertInvestigation } from "@/lib/investigation/fetch-investigation";

// ---------- POST /api/properties/[id]/investigation/fetch ----------
// Trigger investigation providers, upsert PropertyInvestigation with status=needs_review

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "property", "write")) {
      throw new ApiError(403, "物件編集の権限がありません", "FORBIDDEN");
    }

    const property = await prisma.property.findUnique({
      where: { id },
      select: {
        id: true,
        address: true,
        lotNumber: true,
        gpsLat: true,
        gpsLng: true,
        // 担当者スコープ判定用（下の canAccessPropertyRecord で使う）
        createdBy: true,
        assignedTo: true,
      },
    });

    if (!property) {
      throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    }

    // ⚠担当者スコープ（認可・PII 横断監査 2026-07-30）。物件本体と同じ可視範囲に
    // 揃える（発注者判断: 担当外に見せてよいのは地図の線・ヒートマップだけ）。
    // ここは特に**担当外の物件の住所を外部プロバイダへ送信させられる**経路なので、
    // 送信前に弾く（既存の findUnique に列を足すだけで DB 往復は増やさない）。
    if (!canAccessPropertyRecord(session, property)) {
      throw new ApiError(
        403,
        "この物件を操作する権限がありません",
        "FORBIDDEN",
      );
    }

    let targetYear: number | undefined;
    try {
      const body = await request.json();
      if (body?.targetYear) targetYear = Number(body.targetYear);
    } catch {
      // Empty body is fine
    }

    // 第4引数の session で**取得の開始**を担当者スコープで守る（@codex #338 R8）。
    // 開始時点ならまだ外部呼び出し（=課金）が発生していないので、ここで弾くのが正しい。
    const investigation = await runAndUpsertInvestigation(
      id,
      session.id,
      {
        address: property.address,
        lotNumber: property.lotNumber,
        gpsLat: property.gpsLat ? Number(property.gpsLat) : null,
        gpsLng: property.gpsLng ? Number(property.gpsLng) : null,
        targetYear,
      },
      session,
    );

    await writeAuditLog({
      userId: session.id,
      action: "investigation_fetch",
      targetTable: "property_investigations",
      targetId: investigation.id,
      detail: { propertyId: id },
    });

    return apiResponse({ investigation });
  } catch (error) {
    return handleApiError(error);
  }
}
