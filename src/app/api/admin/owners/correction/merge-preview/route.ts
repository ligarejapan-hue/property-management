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
import { writeAuditLog } from "@/lib/audit";
import {
  checkOwnerMergeSafety,
  type OwnerMergeBlockReason,
} from "@/lib/owner-merge";
import { buildOwnerDedupKey } from "@/lib/owner-dedup";

// ---------------------------------------------------------------------------
// POST /api/admin/owners/correction/merge-preview
// ---------------------------------------------------------------------------
// Phase 2-B-α: 重複Owner候補ペア（master / source）の merge dryRun preview。
//
// このルートは DB を一切更新しない。
// 実統合 (execute) は別 PR（Phase 2-B-β）で扱う。
//
// 権限:
//   - user_management:read + owner:read（既存 correction candidates 閲覧と同等）
//   - owner:delete は preview には不要（execute 時に流用予定）
//
// Request body:
//   { masterId: string, sourceId: string }
//
// レスポンス（PII は含めない・enum と件数のみ）:
//   200 {
//     eligible: boolean,
//     blockReasons: OwnerMergeBlockReason[],
//     masterId, sourceId,
//     summary: {
//       propertyOwnersToMove, propertyOwnersToDeduplicate,
//       sourceOwnerMemoCount, sourceOwnerMemoWithPropertyCount,
//       sourceChangeLogCount, sourceImportJobRowCount,
//       sourceVersion, masterVersion,
//       normalizeKeyMatches,
//     }
//   }
//   400 masterId / sourceId が UUID 形式でない
//   403 権限不足
//   404 master / source 両方が存在しない（特殊扱い）
//   422 same_owner_id 等で preview 自体が無意味
//
// archived owner ペアや source_has_changelog などは 200 + eligible=false + blockReasons
// として返す（preview は閲覧操作。詳細を operator に見せる）。
// ---------------------------------------------------------------------------

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RequestBody {
  masterId?: unknown;
  sourceId?: unknown;
}

interface OwnerState {
  id: string;
  name: string;
  address: string | null;
  version: number;
  isArchived: boolean;
  note: string | null;
  externalLinkKey: string | null;
}

async function loadOwnerForMerge(id: string): Promise<OwnerState | null> {
  return prisma.owner.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      address: true,
      version: true,
      isArchived: true,
      note: true,
      externalLinkKey: true,
    },
  });
}

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "user_management", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(perms, "owner", "read")) {
      throw new ApiError(403, "所有者閲覧の権限がありません", "FORBIDDEN");
    }

    const body = (await request.json().catch(() => ({}))) as RequestBody;
    const masterId = body.masterId;
    const sourceId = body.sourceId;

    if (
      typeof masterId !== "string" ||
      !UUID_REGEX.test(masterId) ||
      typeof sourceId !== "string" ||
      !UUID_REGEX.test(sourceId)
    ) {
      throw new ApiError(
        400,
        "masterId / sourceId は UUID 形式で指定してください",
        "INVALID_INPUT",
      );
    }

    // same_owner_id は 422（preview に意味がない）
    if (masterId === sourceId) {
      // PII を含まないエラー shape
      return apiResponse(
        {
          error: {
            message: "master と source に同じ owner を指定できません",
            code: "MERGE_PREVIEW_BLOCKED",
            blockReasons: ["same_owner_id"] satisfies OwnerMergeBlockReason[],
          },
        },
        422,
      );
    }

    // master / source 両方を取得
    const [master, source] = await Promise.all([
      loadOwnerForMerge(masterId),
      loadOwnerForMerge(sourceId),
    ]);

    // 双方とも存在しない場合は 404（特殊扱い）
    if (!master && !source) {
      throw new ApiError(404, "所有者が見つかりません", "NOT_FOUND");
    }

    // 集計値（PII を含まない件数のみ）
    // master / source が存在しない場合は 0 件として safety check に渡す
    const [
      sourceChangeLogCount,
      sourceImportJobRows,
      sourceOwnerMemoCount,
      sourceOwnerMemoWithPropertyCount,
      sourcePropertyOwners,
      masterPropertyOwners,
    ] = await Promise.all([
      source
        ? prisma.changeLog.count({
            where: { targetTable: "owners", targetId: source.id },
          })
        : Promise.resolve(0),
      source
        ? prisma.importJobRow.findMany({
            where: {
              createdId: source.id,
              job: { jobType: "owner_csv" },
            },
            select: { id: true },
          })
        : Promise.resolve([]),
      source
        ? prisma.ownerMemo.count({ where: { ownerId: source.id } })
        : Promise.resolve(0),
      source
        ? prisma.ownerMemo.count({
            where: { ownerId: source.id, propertyId: { not: null } },
          })
        : Promise.resolve(0),
      source
        ? prisma.propertyOwner.findMany({
            where: { ownerId: source.id },
            select: { propertyId: true },
          })
        : Promise.resolve([]),
      master
        ? prisma.propertyOwner.findMany({
            where: { ownerId: master.id },
            select: { propertyId: true },
          })
        : Promise.resolve([]),
    ]);

    const masterPropertyIds = new Set(
      masterPropertyOwners.map((p) => p.propertyId),
    );
    let propertyOwnersToMove = 0;
    let propertyOwnersToDeduplicate = 0;
    for (const sp of sourcePropertyOwners) {
      if (masterPropertyIds.has(sp.propertyId)) {
        propertyOwnersToDeduplicate++;
      } else {
        propertyOwnersToMove++;
      }
    }

    // 正規化キー一致確認: candidate API は normalizeName+normalizeAddress で
    // グループ化しているが、本ルートで再検証する。address が null の場合は
    // 「address なし」を表す sentinel と比較するため厳密一致しない（false）。
    const normalizeKeyMatches = Boolean(
      master &&
        source &&
        master.address &&
        source.address &&
        buildOwnerDedupKey(master.name, master.address) ===
          buildOwnerDedupKey(source.name, source.address),
    );

    // safety check
    const safety = checkOwnerMergeSafety({
      sameOwnerId: false, // 422 で先に弾いている
      masterExists: master !== null,
      sourceExists: source !== null,
      masterIsArchived: master?.isArchived ?? false,
      sourceIsArchived: source?.isArchived ?? false,
      sourceChangeLogCount,
      sourceHasNote: !!source?.note && source.note.trim().length > 0,
      sourceHasExternalLinkKey:
        !!source?.externalLinkKey && source.externalLinkKey.trim().length > 0,
      sourceVersion: source?.version ?? 1,
      normalizeKeyMatches,
    });

    const summary = {
      propertyOwnersToMove,
      propertyOwnersToDeduplicate,
      sourceOwnerMemoCount,
      sourceOwnerMemoWithPropertyCount,
      sourceChangeLogCount,
      sourceImportJobRowCount: sourceImportJobRows.length,
      sourceVersion: source?.version ?? null,
      masterVersion: master?.version ?? null,
      normalizeKeyMatches,
    };

    const eligible = safety.ok;
    const blockReasons = safety.ok ? [] : safety.reasons;

    // AuditLog: 誰がどのペアの preview を取ったかの監査。PII は含めない。
    await writeAuditLog({
      userId: session.id,
      action: "owner_correction_merge_preview",
      targetTable: "owners",
      targetId: masterId,
      detail: {
        masterId,
        sourceId,
        eligible,
        blockReasons,
      },
    });

    return apiResponse({
      eligible,
      blockReasons,
      masterId,
      sourceId,
      summary,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
