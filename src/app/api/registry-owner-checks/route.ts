/**
 * 謄本の名義の確認の一覧(2026-11-08 発注者依頼)。
 *
 *   GET … 謄本の名義とシステムの所有者が違う(表記の違いだけは除く)・まだ判断していない物件。
 *         返すのは物件の ID・住所・DM の状態だけ(氏名は1件ずつ開いたときに謄本から読む)。
 *
 * ⚠見られるのは、所有者の氏名を伏せずに見られて謄本も見られる人だけ(→ permissions.ts)。
 *   担当外の物件は物件一覧と同じく見えない(propertyVisibilityScopeWhere)。CSV は作らない。
 */
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { propertyVisibilityScopeWhere } from "@/lib/property-list-query";
import { hasPermission } from "@/lib/permissions";
import { findMissingRegistryOwnerReviewPerm } from "@/lib/registry-owner-check/permissions";
import {
  countPendingRegistryOwnerChecks,
  REGISTRY_OWNER_CHECK_RUN_MAX,
} from "@/lib/registry-owner-check/service";
import { ownerDiffLabelFromStored } from "@/lib/registry-owner-check/diff";
import type { Prisma } from "@/generated/prisma";

const PAGE_SIZE = 50;

export async function GET(request: Request) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    const missing = findMissingRegistryOwnerReviewPerm(perms, "view");
    if (missing) throw new ApiError(403, missing, "FORBIDDEN");

    const { searchParams } = new URL(request.url);
    const rawOffset = Number(searchParams.get("offset"));
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
    // 違いの種類の順(漢字の違い → … → 別の人・種類がまだ無い行は最後)か、今までの順
    const sortByKind = searchParams.get("sort") === "kind";

    const scope = propertyVisibilityScopeWhere(session);
    const where: Prisma.RegistryOwnerCheckWhereInput = {
      result: "mismatch",
      decision: null,
      stale: false,
      property: { isArchived: false, ...(scope ? { AND: [scope] } : {}) },
    };
    const [total, rows] = await Promise.all([
      prisma.registryOwnerCheck.count({ where }),
      prisma.registryOwnerCheck.findMany({
        where,
        select: {
          propertyId: true,
          checkedAt: true,
          diffKind: true,
          property: { select: { address: true, dmStatus: true } },
        },
        orderBy: sortByKind
          ? [{ diffRank: { sort: "asc", nulls: "last" } }, { propertyId: "asc" }]
          : { propertyId: "asc" },
        skip: offset,
        take: PAGE_SIZE,
      }),
    ]);

    // 全件を比べる操作ができる人(管理者)にだけ、まだ比べていない件数を出す
    const canRun = findMissingRegistryOwnerReviewPerm(perms, "run") === null;
    const pending = canRun ? await countPendingRegistryOwnerChecks() : null;

    return apiResponse({
      data: rows.map((r) => ({
        propertyId: r.propertyId,
        address: r.property.address,
        dmStatus: r.property.dmStatus,
        checkedAt: r.checkedAt,
        // 種類の文言だけ(名前・字は保存していない)。種類を残す前に比べた行は null
        diffKind: ownerDiffLabelFromStored(r.diffKind),
      })),
      sort: sortByKind ? "kind" : "default",
      total,
      offset,
      pageSize: PAGE_SIZE,
      canRun,
      pending,
      runMax: REGISTRY_OWNER_CHECK_RUN_MAX,
      canKeep: findMissingRegistryOwnerReviewPerm(perms, "keep") === null,
      // DM を戻すのは物件の項目の書き換え(物件を編集できる人だけ)
      canRestoreDm: hasPermission(perms, "property", "write"),
      canReplace: findMissingRegistryOwnerReviewPerm(perms, "replace") === null,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
