import prisma from "@/lib/prisma";
import {
  ApiError,
  type ApiSession,
  type PermissionEntry,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";

// ============================================================
// helper: property 認可 (既存 properties API の field_staff scope と整合)
// ============================================================
// field-survey pin に propertyId を紐付ける際の property 認可チェック。
// Next.js の route file は POST/GET 等の handler 以外を export できない
// (build 時の型チェックで弾かれる) ため、route 外の helper に分離する。
// ロジックは従来の pins/route.ts 内実装と同一。
// POST /api/field-survey/pins と PATCH /api/field-survey/pins/[id] から利用する。

export async function assertPropertyAccessible(
  propertyId: string,
  session: ApiSession,
  permissions: PermissionEntry[],
): Promise<void> {
  if (!hasPermission(permissions, "property", "read")) {
    throw new ApiError(
      403,
      "property の閲覧権限がありません",
      "FORBIDDEN",
    );
  }
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { id: true, createdBy: true, assignedTo: true },
  });
  if (!property) {
    throw new ApiError(404, "property が見つかりません", "PROPERTY_NOT_FOUND");
  }
  if (
    session.role === "field_staff" &&
    property.createdBy !== session.id &&
    property.assignedTo !== session.id
  ) {
    throw new ApiError(
      403,
      "この property を pin に紐付ける権限がありません",
      "FORBIDDEN",
    );
  }
}
