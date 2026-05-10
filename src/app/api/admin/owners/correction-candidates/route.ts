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
import { normalizeName, normalizeAddress } from "@/lib/normalize";

type RecommendedAction = "hold" | "review" | "delete_candidate" | "merge_candidate";

type Candidate = {
  id: string;
  name: string;
  address: string | null;
  zip: string | null;
  phone: string | null;
  hasNote: boolean;
  hasExternalLinkKey: boolean;
  version: number;
  propertyOwnerCount: number;
  changeLogCount: number;
  importFileName: string | null;
  importRowNumber: number | null;
  blockReasons: string[];
  recommendedAction: RecommendedAction;
  types: string[];
};

// ---------- GET /api/admin/owners/correction-candidates ----------
//
// Owner 補正候補を dry-run で返す。DB は一切変更しない。
//
// type クエリパラメータ:
//   orphan       — PropertyOwner 件数 = 0
//   address_null — address が null または空文字
//   duplicate    — normalizeName+normalizeAddress が一致する Owner が複数
//   all (default)— 上記いずれかに該当するもの全て
//
// 権限: user_management:read（管理者エリア） + owner:read（PII閲覧）の両方必須。
//   既存 /api/owners と同じ getOwnerDisplayConfig / maskValue を適用する。

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

    // PII フィールドの表示レベルを取得（/api/owners と同じ制御）
    const displayConfig = await getOwnerDisplayConfig(session.id);

    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type") ?? "all";

    // 1. 全アクティブ Owner を PropertyOwner 件数付きで取得
    const owners = await prisma.owner.findMany({
      where: { isArchived: false },
      select: {
        id: true,
        name: true,
        address: true,
        zip: true,
        phone: true,
        note: true,
        externalLinkKey: true,
        version: true,
        _count: { select: { propertyOwners: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    const ownerIds = owners.map((o) => o.id);

    // 2. ChangeLog 件数（Owner には直接リレーションなし — 別クエリで集計）
    const changeLogRows =
      ownerIds.length > 0
        ? await prisma.changeLog.findMany({
            where: { targetTable: "owners", targetId: { in: ownerIds } },
            select: { targetId: true },
          })
        : [];
    const changeLogCountMap = new Map<string, number>();
    for (const row of changeLogRows) {
      changeLogCountMap.set(
        row.targetId,
        (changeLogCountMap.get(row.targetId) ?? 0) + 1,
      );
    }

    // 3. ImportJobRow 逆引き（owner_csv のみ — createdId = Owner.id）
    const importRows =
      ownerIds.length > 0
        ? await prisma.importJobRow.findMany({
            where: {
              createdId: { in: ownerIds },
              job: { jobType: "owner_csv" },
            },
            select: {
              createdId: true,
              rowNumber: true,
              job: { select: { fileName: true } },
            },
            orderBy: { createdAt: "asc" },
          })
        : [];
    // 同一 Owner に複数行あれば最初の1行のみ使用
    const importRowMap = new Map<
      string,
      { fileName: string; rowNumber: number }
    >();
    for (const r of importRows) {
      if (!importRowMap.has(r.createdId!)) {
        importRowMap.set(r.createdId!, {
          fileName: r.job.fileName,
          rowNumber: r.rowNumber,
        });
      }
    }

    // 4. 候補リスト構築
    const candidates: Candidate[] = owners.map((owner): Candidate => {
      const propertyOwnerCount = owner._count.propertyOwners;
      const changeLogCount = changeLogCountMap.get(owner.id) ?? 0;
      const importInfo = importRowMap.get(owner.id) ?? null;

      const blockReasons: string[] = [];
      if (propertyOwnerCount > 0) blockReasons.push("property_owner_exists");
      if (changeLogCount > 0) blockReasons.push("changelog_exists");
      if (owner.version > 1) blockReasons.push("version_gt_1");
      if (owner.externalLinkKey) blockReasons.push("external_link_key_exists");
      if (owner.note) blockReasons.push("note_exists");
      if (!importInfo) blockReasons.push("import_source_unknown");

      const isOrphan = propertyOwnerCount === 0;
      const isAddressNull =
        owner.address === null || owner.address.trim() === "";

      const types: string[] = [];
      if (isOrphan) types.push("orphan");
      if (isAddressNull) types.push("address_null");
      // duplicate は後段で付与

      const hasSafeguard = blockReasons.some((r) =>
        [
          "property_owner_exists",
          "changelog_exists",
          "version_gt_1",
          "external_link_key_exists",
          "note_exists",
        ].includes(r),
      );

      let recommendedAction: RecommendedAction;
      if (hasSafeguard) {
        recommendedAction = "hold";
      } else if (isOrphan && !isAddressNull && importInfo) {
        recommendedAction = "delete_candidate";
      } else {
        recommendedAction = "review";
      }

      return {
        id: owner.id,
        name: owner.name,
        address: owner.address ?? null,
        zip: owner.zip ?? null,
        phone: owner.phone ?? null,
        hasNote: !!owner.note,
        hasExternalLinkKey: !!owner.externalLinkKey,
        version: owner.version,
        propertyOwnerCount,
        changeLogCount,
        importFileName: importInfo?.fileName ?? null,
        importRowNumber: importInfo?.rowNumber ?? null,
        blockReasons,
        recommendedAction,
        types,
      };
    });

    // 5. 重複検出: normalizeName + normalizeAddress でグループ化
    const groups = new Map<string, (typeof candidates)[0][]>();
    for (const c of candidates) {
      const n = normalizeName(c.name);
      const a = c.address
        ? normalizeAddress(c.address)
        : `__noaddr__${c.zip ?? ""}__${c.phone ?? ""}`;
      const key = `${n}|||${a}`;
      const arr = groups.get(key) ?? [];
      arr.push(c);
      groups.set(key, arr);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      for (const c of group) {
        if (!c.types.includes("duplicate")) c.types.push("duplicate");
        if (
          c.recommendedAction === "delete_candidate" ||
          c.recommendedAction === "review"
        ) {
          c.recommendedAction = "merge_candidate";
        }
      }
    }

    // 6. type フィルタ
    let result: typeof candidates;
    if (type === "orphan") {
      result = candidates.filter((c) => c.types.includes("orphan"));
    } else if (type === "address_null") {
      result = candidates.filter((c) => c.types.includes("address_null"));
    } else if (type === "duplicate") {
      result = candidates.filter((c) => c.types.includes("duplicate"));
    } else {
      result = candidates.filter((c) => c.types.length > 0);
    }

    // 7. PII フィールドにマスキングを適用（重複検出は生値で完了済み）
    const maskedResult = result.map((c) => ({
      ...c,
      name: maskValue(c.name, displayConfig.name),
      address: maskValue(c.address, displayConfig.address),
      zip: maskValue(c.zip, displayConfig.zip),
      phone: maskValue(c.phone, displayConfig.phone),
    }));

    return apiResponse({
      total: maskedResult.length,
      type,
      candidates: maskedResult,
      summary: {
        orphanCount: candidates.filter((c) => c.types.includes("orphan")).length,
        addressNullCount: candidates.filter((c) =>
          c.types.includes("address_null"),
        ).length,
        duplicateCount: candidates.filter((c) => c.types.includes("duplicate"))
          .length,
        allCount: candidates.filter((c) => c.types.length > 0).length,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
