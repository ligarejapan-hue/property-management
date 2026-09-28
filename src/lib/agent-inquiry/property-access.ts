import prisma from "@/lib/prisma";
import { ApiError, type ApiSession, type PermissionEntry } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";

/**
 * 物件画面の反響欄・広告の可否の変更は、既存の物件画面と同じ規則(設計 §4)。
 * field_staff は作成者/担当の物件だけ(src/app/api/properties/[id]/route.ts と同じ条件)。
 * ⚠受付の窓(反響の登録・物件検索)はこの規則を使わない=方針10。
 */
async function assertProperty(
  propertyId: string,
  session: ApiSession,
  perms: PermissionEntry[],
  action: "read" | "write",
) {
  if (!hasPermission(perms, "property", action)) throw new ApiError(403, "権限がありません", "FORBIDDEN");
  const p = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { id: true, createdBy: true, assignedTo: true },
  });
  if (!p) throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
  if (session.role === "field_staff" && p.createdBy !== session.id && p.assignedTo !== session.id) {
    throw new ApiError(403, "この物件を閲覧する権限がありません", "FORBIDDEN");
  }
}

export const assertPropertyReadable = (id: string, s: ApiSession, p: PermissionEntry[]) =>
  assertProperty(id, s, p, "read");
export const assertPropertyWritable = (id: string, s: ApiSession, p: PermissionEntry[]) =>
  assertProperty(id, s, p, "write");
