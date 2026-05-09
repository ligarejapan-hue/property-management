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
import { updatePropertySchema } from "@/lib/validators";

// ---------- GET /api/properties/[id] ----------

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "property", "read")) {
      throw new ApiError(403, "物件閲覧の権限がありません", "FORBIDDEN");
    }

    const property = await prisma.property.findUnique({
      where: { id },
      include: {
        assignee: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
        building: { select: { id: true, name: true } },
        propertyOwners: {
          include: {
            owner: {
              select: {
                id: true,
                name: true,
                nameKana: true,
                phone: true,
                zip: true,
                address: true,
                note: true,
                version: true,
              },
            },
          },
          orderBy: { createdAt: "asc" },
        },
        photos: {
          where: { propertyId: id },
          orderBy: { sortOrder: "asc" },
        },
        nextActions: {
          where: { isCompleted: false },
          include: {
            assignee: { select: { id: true, name: true } },
          },
          orderBy: { scheduledAt: "asc" },
          take: 5,
        },
      },
    });

    if (!property) {
      throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    }

    // field_staff can only see their own assigned/created properties
    if (
      session.role === "field_staff" &&
      property.createdBy !== session.id &&
      property.assignedTo !== session.id
    ) {
      throw new ApiError(403, "この物件を閲覧する権限がありません", "FORBIDDEN");
    }

    await writeAuditLog({
      userId: session.id,
      action: "property_view",
      targetTable: "properties",
      targetId: property.id,
    });

    // 最初の取込行を取得して取込元情報を付与する
    const importRow = await prisma.importJobRow.findFirst({
      where: { createdId: id, status: "success" },
      select: {
        rowNumber: true,
        rawData: true,
        job: { select: { fileName: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    const importSource = importRow
      ? ((importRow.rawData as Record<string, string>)?.__sourceRef ??
          `${importRow.job.fileName}:${importRow.rowNumber}行`)
      : null;

    return apiResponse({ ...property, importSource });
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- PATCH /api/properties/[id] ----------

export async function PATCH(
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

    const body = await request.json();
    const data = updatePropertySchema.parse(body);
    const { version, ...updateFields } = data;

    // Optimistic locking: only update if version matches
    const current = await prisma.property.findUnique({
      where: { id },
      select: {
        id: true,
        version: true,
        createdBy: true,
        assignedTo: true,
        propertyType: true,
        address: true,
        lotNumber: true,
        buildingNumber: true,
        realEstateNumber: true,
        registryStatus: true,
        dmStatus: true,
        caseStatus: true,
        gpsLat: true,
        gpsLng: true,
        zoningDistrict: true,
        buildingCoverageRatio: true,
        floorAreaRatio: true,
        heightDistrict: true,
        firePreventionZone: true,
        scenicRestriction: true,
        roadType: true,
        roadWidth: true,
        frontageWidth: true,
        frontageDirection: true,
        setbackRequired: true,
        rosenkaValue: true,
        rosenkaYear: true,
        rebuildPermission: true,
        architectureNote: true,
        note: true,
      },
    });

    if (!current) {
      throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    }

    if (current.version !== version) {
      throw new ApiError(
        409,
        "他のユーザーが先に更新しています。画面を再読み込みしてください。",
        "VERSION_CONFLICT",
      );
    }

    // field_staff scope check
    if (
      session.role === "field_staff" &&
      current.createdBy !== session.id &&
      current.assignedTo !== session.id
    ) {
      throw new ApiError(403, "この物件を編集する権限がありません", "FORBIDDEN");
    }

    // Build change log entries
    const changeLogs: Array<{
      targetTable: string;
      targetId: string;
      fieldName: string;
      oldValue: string | null;
      newValue: string | null;
      source: "manual";
      changedBy: string;
    }> = [];

    for (const [key, newVal] of Object.entries(updateFields)) {
      if (newVal === undefined) continue;
      const oldVal = (current as Record<string, unknown>)[key];
      const oldStr = oldVal != null ? String(oldVal) : null;
      const newStr = newVal != null ? String(newVal) : null;
      if (oldStr !== newStr) {
        changeLogs.push({
          targetTable: "properties",
          targetId: id,
          fieldName: key,
          oldValue: oldStr,
          newValue: newStr,
          source: "manual",
          changedBy: session.id,
        });
      }
    }

    // Update property with version increment
    const updated = await prisma.property.update({
      where: { id },
      data: {
        ...updateFields,
        version: { increment: 1 },
      },
      include: {
        assignee: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
        propertyOwners: {
          include: {
            owner: {
              select: {
                id: true,
                name: true,
                nameKana: true,
                phone: true,
                zip: true,
                address: true,
                note: true,
                version: true,
              },
            },
          },
        },
        photos: { orderBy: { sortOrder: "asc" } },
        nextActions: {
          where: { isCompleted: false },
          include: { assignee: { select: { id: true, name: true } } },
          orderBy: { scheduledAt: "asc" },
          take: 5,
        },
      },
    });

    // Write change logs
    if (changeLogs.length > 0) {
      await prisma.changeLog.createMany({ data: changeLogs });
    }

    // Write audit log
    await writeAuditLog({
      userId: session.id,
      action: "update",
      targetTable: "properties",
      targetId: id,
      detail: { updatedFields: changeLogs.map((c) => c.fieldName) },
    });

    return apiResponse(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- DELETE /api/properties/[id] ----------
// 物件を物理削除する。子レコード（PropertyOwner / PropertyPhoto / Comment 等）は
// schema 側の onDelete: Cascade により自動で消える。ChangeLog / AuditLog は
// targetTable+targetId の弱参照なのでそのまま残る（監査履歴を保持するため）。

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "property", "write")) {
      throw new ApiError(403, "物件削除の権限がありません", "FORBIDDEN");
    }

    const property = await prisma.property.findUnique({
      where: { id },
      select: { id: true, address: true, createdBy: true, assignedTo: true },
    });

    if (!property) {
      throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    }

    if (
      session.role === "field_staff" &&
      property.createdBy !== session.id &&
      property.assignedTo !== session.id
    ) {
      throw new ApiError(403, "この物件を削除する権限がありません", "FORBIDDEN");
    }

    await prisma.property.delete({ where: { id } });

    await writeAuditLog({
      userId: session.id,
      action: "delete",
      targetTable: "properties",
      targetId: id,
      detail: { address: property.address },
    });

    return apiResponse({ id, deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
