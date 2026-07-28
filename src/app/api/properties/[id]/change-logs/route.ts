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
import { canAccessPropertyRecord } from "@/lib/property-access";

// ---------- GET /api/properties/:id/change-logs ----------

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: propertyId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "property", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const { searchParams } = new URL(request.url);
    const page = Math.max(1, Number(searchParams.get("page")) || 1);
    const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit")) || 50));
    const fieldName = searchParams.get("fieldName") ?? "";
    const source = searchParams.get("source") ?? "";
    const from = searchParams.get("from") ?? "";
    const to = searchParams.get("to") ?? "";

    // 関連レコードの ChangeLog は「その行の id」で記録されている。
    // property_owners は PropertyOwner.id、buildings は Building.id であって
    // propertyId ではないため、propertyId で引くと構造的に常に 0 件になり、
    // 所有者の続柄変更・主所有者切替・棟情報の変更が履歴タブに一切出なかった
    // (総点検 2026-07-27)。実 id を引いてから検索する。
    // ※記録済みのデータは残っているので、現存するリンクの履歴は遡って表示される。
    //
    // ⚠既知の制限: PropertyOwner は物理削除 (ソフトデリート列なし) のため、
    // **紐づけ解除された**リンクの履歴 (解除イベント自体と、解除前にその
    // リンクへ行った続柄変更・主所有者切替) はここから引けない。ChangeLog は
    // targetTable/targetId しか持たず propertyId を保持しないため、消えた
    // リンク id を物件から逆引きする手段が無い。
    // 解決には ChangeLog に propertyId を持たせる等のスキーマ変更が要るので
    // 別タスク (要承認)。mislink/merge 経由の削除でも同じ。
    // レコード単位のアクセス制御 (物件詳細 API GET /api/properties/[id] と同方針)。
    // ⚠関連レコードを引く前に必ず弾く (@codex #330 R2)。この route は
    // property:read しか見ていなかったため、field_staff が担当外の物件 id を
    // 指定すると変更履歴が読めていた。関連の所有者リンク/棟まで引くようにした
    // 分だけ (続柄・主所有者・棟情報の変更) 読める範囲が広がってしまう。
    const propertyRow = await prisma.property.findUnique({
      where: { id: propertyId },
      select: { id: true, buildingId: true, createdBy: true, assignedTo: true },
    });
    if (!propertyRow) {
      throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    }
    if (!canAccessPropertyRecord(session, propertyRow)) {
      throw new ApiError(403, "この物件を閲覧する権限がありません", "FORBIDDEN");
    }

    const ownerLinks = await prisma.propertyOwner.findMany({
      where: { propertyId },
      select: { id: true },
    });
    const ownerLinkIds = ownerLinks.map((o) => o.id);
    const buildingId = propertyRow.buildingId;

    // 対象が無いテーブルは OR から外す (常に 0 件の条件を積まない)。
    const targetFilters: Array<Record<string, unknown>> = [
      { targetTable: "properties", targetId: propertyId },
    ];
    if (ownerLinkIds.length > 0) {
      targetFilters.push({
        targetTable: "property_owners",
        targetId: { in: ownerLinkIds },
      });
    }
    if (buildingId) {
      targetFilters.push({ targetTable: "buildings", targetId: buildingId });
    }

    // Fetch change logs for this property and its related owners
    const where: Record<string, unknown> = { OR: targetFilters };

    if (fieldName) where.fieldName = fieldName;
    if (source) where.source = source;
    if (from || to) {
      const changedAt: Record<string, Date> = {};
      if (from) changedAt.gte = new Date(from);
      if (to) changedAt.lte = new Date(to + "T23:59:59Z");
      where.changedAt = changedAt;
    }

    const [logs, total] = await Promise.all([
      prisma.changeLog.findMany({
        where,
        include: {
          changer: { select: { id: true, name: true } },
        },
        orderBy: { changedAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.changeLog.count({ where }),
    ]);

    // Get distinct field names and sources for filter dropdowns
    const [fieldNames, sources] = await Promise.all([
      prisma.changeLog.groupBy({
        by: ["fieldName"],
        // 一覧と同じ対象条件を使う (片方だけ古い条件だと、履歴には出るのに
        // フィルタの選択肢に出ない/その逆が起きる)。
        where: { OR: targetFilters },
        orderBy: { fieldName: "asc" },
      }),
      prisma.changeLog.groupBy({
        by: ["source"],
        where: { OR: targetFilters },
        orderBy: { source: "asc" },
      }),
    ]);

    return apiResponse({
      data: logs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
      fieldNames: fieldNames.map((f) => f.fieldName),
      sources: sources.map((s) => s.source),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
