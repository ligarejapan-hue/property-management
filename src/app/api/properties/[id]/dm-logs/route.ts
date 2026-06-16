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
import { hasPermission, maskValue } from "@/lib/permissions";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { writeAuditLog } from "@/lib/audit";

// ---------- GET /api/properties/:id/dm-logs ----------
//
// 物件の DM 送付履歴（PropertyDmLog）を read-only で返す（B-3 PR-1）。
//   - 認可: property:read + owner:read（DM 送付は所有者宛のため owner:read も要求）。
//     いずれか欠ける場合は 403 とし、DB 取得・AuditLog 書き込みを一切行わない。
//   - PII: note は所有者備考と同じ表示レベル（owner_note → ownerDisplayConfig.note）で
//     server-side マスクする（生値はクライアントに返さない）。
//   - 送信者名（staff）・method・日付は PII ではないため素表示（change-logs の changer.name と同方針）。
//   - 非PII の AuditLog（件数・閲覧時刻のみ。note 本文・送信者名・owner 由来キーは残さない）。
//
// 送付確定 write / 反響 / 再送 / migration は対象外（PR-2 以降・別承認）。

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: propertyId } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    // 権限ゲート。欠ける場合は DB 取得・AuditLog を行わず 403。
    if (!hasPermission(permissions, "property", "read")) {
      throw new ApiError(403, "物件情報の閲覧権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(permissions, "owner", "read")) {
      throw new ApiError(403, "所有者情報の閲覧権限がありません", "FORBIDDEN");
    }

    // レコード単位のアクセス制御（物件詳細 API GET /api/properties/[id] と同方針）。
    // field_staff は createdBy / assignedTo の物件のみ閲覧可。propertyId だけで DM 履歴を
    // 引けると担当外物件の送付履歴（および note）が読めてしまうため、ログ取得・監査の前に弾く。
    const property = await prisma.property.findUnique({
      where: { id: propertyId },
      select: { id: true, createdBy: true, assignedTo: true },
    });
    if (!property) {
      throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    }
    if (!canAccessPropertyRecord(session, property)) {
      throw new ApiError(403, "この物件を閲覧する権限がありません", "FORBIDDEN");
    }

    // note のマスクに使う表示レベル（owner_note）。取得済み permissions を再利用して二重解決を避ける。
    const ownerDisplayConfig = await getOwnerDisplayConfig(session.id, permissions);

    const { searchParams } = new URL(request.url);
    const page = Math.max(1, Number(searchParams.get("page")) || 1);
    const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit")) || 50));

    const where = { propertyId };

    const [logs, total] = await Promise.all([
      prisma.propertyDmLog.findMany({
        where,
        select: {
          id: true,
          sentAt: true,
          method: true,
          note: true,
          createdAt: true,
          sender: { select: { id: true, name: true } },
        },
        orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.propertyDmLog.count({ where }),
    ]);

    // note は所有者備考と同じ表示レベルで server-side マスク（生値を返さない）。
    const data = logs.map((log) => ({
      id: log.id,
      // sentAt は @db.Date（日付のみ）。UTC 基準の YYYY-MM-DD 文字列で返し、
      // クライアントでの TZ 依存の日付ずれ（負オフセットで前日表示）を防ぐ。
      sentAt: log.sentAt.toISOString().slice(0, 10),
      method: log.method,
      note: maskValue(log.note, ownerDisplayConfig.note),
      sentBy: { id: log.sender.id, name: log.sender.name },
      createdAt: log.createdAt,
    }));

    // 非PII の操作監査（note 本文・送信者名などの PII は残さない）。
    await writeAuditLog({
      userId: session.id,
      action: "property_dm_log_view",
      targetTable: "property_dm_logs",
      targetId: propertyId,
      detail: {
        count: data.length,
        total,
        page,
        viewedAt: new Date().toISOString(),
      },
    });

    return apiResponse({
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
