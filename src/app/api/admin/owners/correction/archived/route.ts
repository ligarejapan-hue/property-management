// GET /api/admin/owners/correction/archived?page=0
//
// アーカイブ済みの所有者の一覧(2026-11-24 発注者「作る」)。「戻す」は
// POST /api/admin/owners/:id/correction/unarchive。
//
// - 権限: user_management:read AND owner:read(補正候補の一覧と同じ)。
// - 氏名・住所は表示権限どおりに伏せる(maskValue)。統合先の氏名も同じ。
// - 統合で隠れたか(_merged_from の記録)・隠した日時(isArchived の記録)を添える。
// - AuditLog には件数だけ(Owner.id・氏名・住所を入れない)。
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
import { writeAuditLog } from "@/lib/audit";
import {
  ARCHIVED_PAGE_SIZE,
  classifyArchiveOrigin,
  type ArchivedOwnerRow,
} from "@/lib/owner-archived";

function parsePage(input: string | null): number {
  const n = Number(input ?? "0");
  if (!Number.isInteger(n) || n < 0) return 0;
  return Math.min(n, 10_000);
}

export async function GET(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    if (!hasPermission(perms, "user_management", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(perms, "owner", "read")) {
      throw new ApiError(403, "所有者閲覧の権限がありません", "FORBIDDEN");
    }
    const cfg = await getOwnerDisplayConfig(session.id, perms);

    const page = parsePage(new URL(request.url).searchParams.get("page"));
    const where = { isArchived: true };
    const [owners, total] = await Promise.all([
      prisma.owner.findMany({
        where,
        select: { id: true, name: true, address: true, version: true },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        skip: page * ARCHIVED_PAGE_SIZE,
        take: ARCHIVED_PAGE_SIZE,
      }),
      prisma.owner.count({ where }),
    ]);
    const ids = owners.map((o) => o.id);

    const [mergeLogs, archiveLogs] =
      ids.length === 0
        ? [[], []]
        : await Promise.all([
            prisma.changeLog.findMany({
              where: { targetTable: "owners", fieldName: "_merged_from", newValue: { in: ids } },
              select: { targetId: true, newValue: true, changedAt: true },
              orderBy: { changedAt: "desc" },
            }),
            prisma.changeLog.findMany({
              where: {
                targetTable: "owners",
                fieldName: "isArchived",
                newValue: "true",
                targetId: { in: ids },
              },
              select: { targetId: true, changedAt: true },
              orderBy: { changedAt: "desc" },
            }),
          ]);

    // 新しい順に並んでいるので、最初に出たものがその人の最後の記録。
    const lastMerge = new Map<string, { masterId: string; at: Date }>();
    for (const l of mergeLogs) {
      if (l.newValue && !lastMerge.has(l.newValue)) {
        lastMerge.set(l.newValue, { masterId: l.targetId, at: l.changedAt });
      }
    }
    const lastArchive = new Map<string, Date>();
    for (const l of archiveLogs) {
      if (!lastArchive.has(l.targetId)) lastArchive.set(l.targetId, l.changedAt);
    }

    const masterIds = [...new Set([...lastMerge.values()].map((m) => m.masterId))];
    const masters =
      masterIds.length === 0
        ? []
        : await prisma.owner.findMany({
            where: { id: { in: masterIds } },
            select: { id: true, name: true, isArchived: true },
          });
    const masterById = new Map(masters.map((m) => [m.id, m]));

    const rows: ArchivedOwnerRow[] = owners.map((o) => {
      const merge = lastMerge.get(o.id) ?? null;
      const archivedAt = lastArchive.get(o.id) ?? null;
      const origin = classifyArchiveOrigin({
        lastArchivedAt: archivedAt,
        lastMergedAt: merge?.at ?? null,
      });
      const master = origin === "merged" && merge ? masterById.get(merge.masterId) : undefined;
      return {
        ownerId: o.id,
        ownerNameMasked: maskValue(o.name, cfg.name),
        addressMasked: maskValue(o.address, cfg.address),
        version: o.version,
        origin,
        mergedInto: master
          ? {
              ownerId: master.id,
              ownerNameMasked: maskValue(master.name, cfg.name),
              isArchived: master.isArchived,
            }
          : null,
        archivedAt: (archivedAt ?? merge?.at ?? null)?.toISOString() ?? null,
        detailUrl: `/admin/owners/${o.id}`,
      };
    });

    await writeAuditLog({
      userId: session.id,
      action: "owner_correction_archived_list",
      detail: { page, resultCount: rows.length, total },
    });

    return apiResponse({ rows, total, page, pageSize: ARCHIVED_PAGE_SIZE });
  } catch (error) {
    return handleApiError(error);
  }
}
