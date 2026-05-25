/**
 * /uploads/[...path] Phase B: entity-level 権限判定。
 *
 * key を fileUrl 完全一致で DB 逆引きし、Photo / Attachment / Property の
 * スコープに基づいて 200 / 403 / 404 のいずれを返すべきかを決定する。
 *
 * 注:
 *  - key 形式から propertyId / buildingId を推定しない。逆引き結果のみを使う。
 *  - 不明 prefix / 逆引き 0 件は 404（安全側）。
 *  - isDeleted の Attachment は 404（存在しないものとして扱う）。
 *  - 既存 Property API のスコープ (field_staff = createdBy or assignedTo) に揃える。
 */

import prismaDefault from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";
import { isValidStorageKey } from "@/lib/storage/key-validation";
import type { ApiSession, PermissionEntry } from "@/lib/api-helpers";

type PrismaLike = typeof prismaDefault;

export type UploadAuthDecision = "ok" | "forbidden" | "not_found";

export interface AuthorizeUploadAccessArgs {
  key: string;
  session: ApiSession;
  permissions: PermissionEntry[];
  prisma?: PrismaLike;
}

export async function authorizeUploadAccess(
  args: AuthorizeUploadAccessArgs,
): Promise<UploadAuthDecision> {
  const { key, session, permissions } = args;
  const db: PrismaLike = args.prisma ?? prismaDefault;

  if (!isValidStorageKey(key)) return "forbidden";

  const fileUrl = `/uploads/${key}`;

  const photo = await db.propertyPhoto.findFirst({
    where: { fileUrl },
    select: { propertyId: true },
  });
  if (photo) {
    return authorizePropertyAccess(photo.propertyId, session, permissions, db);
  }

  const buildingPhoto = await db.buildingPhoto.findFirst({
    where: { fileUrl },
    select: { buildingId: true },
  });
  if (buildingPhoto) {
    return hasPermission(permissions, "property", "read") ? "ok" : "forbidden";
  }

  const attachment = await db.attachment.findFirst({
    where: { fileUrl },
    select: {
      isDeleted: true,
      targetType: true,
      targetId: true,
      propertyId: true,
    },
  });
  if (attachment) {
    if (attachment.isDeleted) return "not_found";
    if (attachment.targetType === "property") {
      const propertyId = attachment.propertyId ?? attachment.targetId;
      return authorizePropertyAccess(propertyId, session, permissions, db);
    }
    if (attachment.targetType === "owner") {
      return hasPermission(permissions, "owner", "read") ? "ok" : "forbidden";
    }
    return "forbidden";
  }

  return "not_found";
}

async function authorizePropertyAccess(
  propertyId: string,
  session: ApiSession,
  permissions: PermissionEntry[],
  db: PrismaLike,
): Promise<UploadAuthDecision> {
  if (!hasPermission(permissions, "property", "read")) return "forbidden";

  const property = await db.property.findUnique({
    where: { id: propertyId },
    select: { createdBy: true, assignedTo: true },
  });
  if (!property) return "not_found";

  if (
    session.role === "field_staff" &&
    property.createdBy !== session.id &&
    property.assignedTo !== session.id
  ) {
    return "forbidden";
  }
  return "ok";
}
