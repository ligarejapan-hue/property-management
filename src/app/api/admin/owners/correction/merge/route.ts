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
import { buildOwnerDuplicateCandidateKey } from "@/lib/owner-correction";

// ---------------------------------------------------------------------------
// POST /api/admin/owners/correction/merge
// ---------------------------------------------------------------------------
// Phase 2-B-β: 重複Owner 統合 execute（1 master + 1 source の単一ペア）。
//
// 権限:
//   - dryRun=true / dryRun=false の両方とも:
//     user_management:read + owner:read + owner:delete
//   - preview 用 /merge-preview は引き続き owner:delete 不要で維持。
//
// Request body:
//   {
//     masterId: string (UUID),
//     sourceId: string (UUID),
//     masterVersion: int,
//     sourceVersion: int,
//     dryRun?: boolean (default true)
//   }
//
// レスポンス（PII を含まない・enum / 件数 / ID のみ）:
//   dryRun=true:
//     200 { executed: false, eligible, blockReasons[], summary }
//   dryRun=false success:
//     200 {
//       executed: true,
//       masterId, masterVersion (new),
//       sourceId, sourceVersion (new),
//       result: { propertyOwnersMoved, propertyOwnersDeduplicated,
//                 ownerMemosMoved, sourceArchived: true }
//     }
//   400 UUID / version 不正
//   403 権限不足
//   404 master / source 両方不存在
//   409 version_mismatch（execute 時のみ）
//   422 same_owner_id / その他 safety 違反
//
// transaction 設計:
//   1. master/source の owner 行を id sort 順で lock（updateMany touch）
//   2. tx 内で master/source / 関連件数を再取得
//   3. checkOwnerMergeSafety を再実行
//   4. masterVersion / sourceVersion 不一致 → version_mismatch
//   5. OwnerMemo を master に移行（body / createdAt / createdBy / propertyId 保持）
//   6. master と重複する PropertyOwner を source 側から削除
//   7. 残る PropertyOwner を master に付け替え
//   8. source を isArchived=true + version increment（WHERE に防御的に
//      propertyOwners: { none: {} } と ownerMemos: { none: {} } を入れる）
//   9. master.version を increment
//   10. ChangeLog を batch 書き込み
// transaction commit 後に AuditLog（PII フリー）
// ---------------------------------------------------------------------------

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RequestBody {
  masterId?: unknown;
  sourceId?: unknown;
  masterVersion?: unknown;
  sourceVersion?: unknown;
  dryRun?: unknown;
}

interface OwnerState {
  id: string;
  name: string;
  address: string | null;
  zip: string | null;
  phone: string | null;
  version: number;
  isArchived: boolean;
  note: string | null;
  externalLinkKey: string | null;
}

interface MergeSummary {
  propertyOwnersToMove: number;
  propertyOwnersToDeduplicate: number;
  sourceOwnerMemoCount: number;
  sourceOwnerMemoWithPropertyCount: number;
  sourceChangeLogCount: number;
  sourceImportJobRowCount: number;
  sourceVersion: number | null;
  masterVersion: number | null;
  normalizeKeyMatches: boolean;
}

function statusFromReasons(reasons: OwnerMergeBlockReason[]): number {
  // version_mismatch は 409、それ以外は 422。
  if (reasons.includes("version_mismatch")) return 409;
  return 422;
}

async function loadOwnerForMerge(id: string): Promise<OwnerState | null> {
  return prisma.owner.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      address: true,
      zip: true,
      phone: true,
      version: true,
      isArchived: true,
      note: true,
      externalLinkKey: true,
    },
  });
}

async function loadOwnerForMergeTx(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  id: string,
): Promise<OwnerState | null> {
  return tx.owner.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      address: true,
      zip: true,
      phone: true,
      version: true,
      isArchived: true,
      note: true,
      externalLinkKey: true,
    },
  });
}

function computeNormalizeKeyMatches(
  master: OwnerState | null,
  source: OwnerState | null,
): boolean {
  return Boolean(
    master &&
      source &&
      buildOwnerDuplicateCandidateKey({
        name: master.name,
        address: master.address,
        zip: master.zip,
        phone: master.phone,
      }) ===
        buildOwnerDuplicateCandidateKey({
          name: source.name,
          address: source.address,
          zip: source.zip,
          phone: source.phone,
        }),
  );
}

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    // 権限: execute API は dryRun=true でも owner:delete を必須。
    if (!hasPermission(perms, "user_management", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(perms, "owner", "read")) {
      throw new ApiError(403, "所有者閲覧の権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(perms, "owner", "delete")) {
      throw new ApiError(403, "所有者統合の権限がありません", "FORBIDDEN");
    }

    const body = (await request.json().catch(() => ({}))) as RequestBody;
    const masterId = body.masterId;
    const sourceId = body.sourceId;
    const masterVersion = body.masterVersion;
    const sourceVersion = body.sourceVersion;
    // dryRun の default は true。dryRun=false を明示したときのみ DB を更新する。
    const dryRun = body.dryRun !== false;

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
    if (
      typeof masterVersion !== "number" ||
      !Number.isInteger(masterVersion) ||
      masterVersion < 1 ||
      typeof sourceVersion !== "number" ||
      !Number.isInteger(sourceVersion) ||
      sourceVersion < 1
    ) {
      throw new ApiError(
        400,
        "masterVersion / sourceVersion は正の整数で指定してください",
        "INVALID_INPUT",
      );
    }

    if (masterId === sourceId) {
      return apiResponse(
        {
          error: {
            message: "master と source に同じ owner を指定できません",
            code: "MERGE_BLOCKED",
            blockReasons: ["same_owner_id"] satisfies OwnerMergeBlockReason[],
          },
        },
        422,
      );
    }

    const [master, source] = await Promise.all([
      loadOwnerForMerge(masterId),
      loadOwnerForMerge(sourceId),
    ]);

    if (!master && !source) {
      throw new ApiError(404, "所有者が見つかりません", "NOT_FOUND");
    }

    // 集計（PII を含まない件数のみ）
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
            where: { createdId: source.id, job: { jobType: "owner_csv" } },
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

    const normalizeKeyMatches = computeNormalizeKeyMatches(master, source);

    const safety = checkOwnerMergeSafety({
      sameOwnerId: false,
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

    // version 不一致は execute 時のみ blocker（preview ではチェックしない）。
    // dryRun=true でも version 不整合を operator に伝えるために含める。
    const versionMismatch = Boolean(
      (master && master.version !== masterVersion) ||
        (source && source.version !== sourceVersion),
    );

    const blockReasons: OwnerMergeBlockReason[] = [
      ...(safety.ok ? [] : safety.reasons),
      ...(versionMismatch ? (["version_mismatch"] as const) : []),
    ];
    const eligible = blockReasons.length === 0;

    const summary: MergeSummary = {
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

    // ── dryRun: DB / AuditLog 一切書かない ─────────────────────────────────
    if (dryRun) {
      return apiResponse({
        executed: false,
        eligible,
        blockReasons,
        masterId,
        sourceId,
        summary,
      });
    }

    // ── dryRun=false: execute ─────────────────────────────────────────────
    if (!eligible) {
      return apiResponse(
        {
          error: {
            message: "統合条件を満たしていません",
            code: "MERGE_BLOCKED",
            blockReasons,
          },
        },
        statusFromReasons(blockReasons),
      );
    }

    // master / source が null でないことは eligible=true で保証済み
    if (!master || !source) {
      throw new ApiError(404, "所有者が見つかりません", "NOT_FOUND");
    }

    const TX_BLOCKED_SENTINEL = "__merge_blocked_in_tx__";
    let txBlockedReasons: OwnerMergeBlockReason[] | null = null;
    let txNotFound = false;
    let propertyOwnersMoved = 0;
    let propertyOwnersDeduplicated = 0;
    let ownerMemosMoved = 0;
    const newMasterVersion = masterVersion + 1;
    const newSourceVersion = sourceVersion + 1;

    try {
      await prisma.$transaction(async (tx) => {
        // 1. master / source の owner 行を id sort 順で lock。
        //    PR #25 と同じ「updateMany touch & verify」パターンで、
        //    archive / merge と直列化する。deadlock 回避のため lex 順。
        const [firstId, secondId] = [master.id, source.id].sort();
        const lockFirst = await tx.owner.updateMany({
          where: { id: firstId, isArchived: false },
          data: { updatedAt: new Date() },
        });
        if (lockFirst.count === 0) {
          txNotFound = true;
          throw new Error(TX_BLOCKED_SENTINEL);
        }
        const lockSecond = await tx.owner.updateMany({
          where: { id: secondId, isArchived: false },
          data: { updatedAt: new Date() },
        });
        if (lockSecond.count === 0) {
          txNotFound = true;
          throw new Error(TX_BLOCKED_SENTINEL);
        }

        // 2. tx 内で再取得
        const [masterFresh, sourceFresh] = await Promise.all([
          loadOwnerForMergeTx(tx, master.id),
          loadOwnerForMergeTx(tx, source.id),
        ]);
        if (!masterFresh || !sourceFresh) {
          txNotFound = true;
          throw new Error(TX_BLOCKED_SENTINEL);
        }

        const [
          freshChangeLog,
          freshMemoCount,
          freshSourcePOs,
          freshMasterPOs,
        ] = await Promise.all([
          tx.changeLog.count({
            where: { targetTable: "owners", targetId: sourceFresh.id },
          }),
          tx.ownerMemo.count({ where: { ownerId: sourceFresh.id } }),
          tx.propertyOwner.findMany({
            where: { ownerId: sourceFresh.id },
            select: { propertyId: true },
          }),
          tx.propertyOwner.findMany({
            where: { ownerId: masterFresh.id },
            select: { propertyId: true },
          }),
        ]);

        const freshMasterPropertyIds = new Set(
          freshMasterPOs.map((p) => p.propertyId),
        );
        const freshNormalizeKeyMatches = computeNormalizeKeyMatches(
          masterFresh,
          sourceFresh,
        );

        // 3. safety を再評価
        const freshSafety = checkOwnerMergeSafety({
          sameOwnerId: false,
          masterExists: true,
          sourceExists: true,
          masterIsArchived: masterFresh.isArchived,
          sourceIsArchived: sourceFresh.isArchived,
          sourceChangeLogCount: freshChangeLog,
          sourceHasNote:
            !!sourceFresh.note && sourceFresh.note.trim().length > 0,
          sourceHasExternalLinkKey:
            !!sourceFresh.externalLinkKey &&
            sourceFresh.externalLinkKey.trim().length > 0,
          sourceVersion: sourceFresh.version,
          normalizeKeyMatches: freshNormalizeKeyMatches,
        });

        // 4. version check
        const freshVersionMismatch =
          masterFresh.version !== masterVersion ||
          sourceFresh.version !== sourceVersion;

        const freshReasons: OwnerMergeBlockReason[] = [
          ...(freshSafety.ok ? [] : freshSafety.reasons),
          ...(freshVersionMismatch
            ? (["version_mismatch"] as const)
            : []),
        ];
        if (freshReasons.length > 0) {
          txBlockedReasons = freshReasons;
          throw new Error(TX_BLOCKED_SENTINEL);
        }

        // 5. OwnerMemo を master に移行（body / createdAt / createdBy /
        //    propertyId は一切触らない）。
        const memoResult = await tx.ownerMemo.updateMany({
          where: { ownerId: sourceFresh.id },
          data: { ownerId: masterFresh.id },
        });
        ownerMemosMoved = memoResult.count;

        // 6. master と重複する PropertyOwner を source 側から削除
        //    （@@unique(propertyId, ownerId) を回避するため）。
        //    削除対象を ChangeLog に記録するため、先に id を取得。
        const dedupeTargets = await tx.propertyOwner.findMany({
          where: {
            ownerId: sourceFresh.id,
            propertyId: { in: Array.from(freshMasterPropertyIds) },
          },
          select: { id: true },
        });
        if (dedupeTargets.length > 0) {
          await tx.propertyOwner.deleteMany({
            where: { id: { in: dedupeTargets.map((p) => p.id) } },
          });
        }
        propertyOwnersDeduplicated = dedupeTargets.length;

        // 7. 残る PropertyOwner を master に付け替え。ChangeLog 用に id 一覧を
        //    取得してから updateMany する。
        const moveTargets = await tx.propertyOwner.findMany({
          where: { ownerId: sourceFresh.id },
          select: { id: true },
        });
        if (moveTargets.length > 0) {
          await tx.propertyOwner.updateMany({
            where: { id: { in: moveTargets.map((p) => p.id) } },
            data: { ownerId: masterFresh.id },
          });
        }
        propertyOwnersMoved = moveTargets.length;

        // 8. source を archive。防御的に propertyOwners: { none: {} } と
        //    ownerMemos: { none: {} } を where に含める。
        //    本来 6/7 + 5 で 0 件になっているはずだが、並行レースで増えていた
        //    場合に検出する。
        const sourceArchive = await tx.owner.updateMany({
          where: {
            id: sourceFresh.id,
            version: sourceVersion,
            isArchived: false,
            propertyOwners: { none: {} },
            memos: { none: {} },
          },
          data: { isArchived: true, version: { increment: 1 } },
        });
        if (sourceArchive.count === 0) {
          // version は最後に再確認するため、ここに来る原因は並行レースで
          // PO / memo が増えた、または直前に archive された等。
          txBlockedReasons = ["version_mismatch"];
          throw new Error(TX_BLOCKED_SENTINEL);
        }

        // 9. master の version も bump（stale client invalidate）
        const masterBump = await tx.owner.updateMany({
          where: {
            id: masterFresh.id,
            version: masterVersion,
            isArchived: false,
          },
          data: { version: { increment: 1 } },
        });
        if (masterBump.count === 0) {
          txBlockedReasons = ["version_mismatch"];
          throw new Error(TX_BLOCKED_SENTINEL);
        }

        // 10. ChangeLog 書き込み（PII を含まない ID / 合成 fieldName のみ）
        const changeLogs: Array<{
          targetTable: string;
          targetId: string;
          fieldName: string;
          oldValue: string | null;
          newValue: string | null;
          source: "manual";
          changedBy: string;
        }> = [];

        // source の isArchived 変化（archive route と同じ shape）
        changeLogs.push({
          targetTable: "owners",
          targetId: sourceFresh.id,
          fieldName: "isArchived",
          oldValue: "false",
          newValue: "true",
          source: "manual",
          changedBy: session.id,
        });

        // master への合成: どの source から統合されたかを記録
        changeLogs.push({
          targetTable: "owners",
          targetId: masterFresh.id,
          fieldName: "_merged_from",
          oldValue: null,
          newValue: sourceFresh.id,
          source: "manual",
          changedBy: session.id,
        });

        // PropertyOwner 単位: 削除と移動
        for (const t of dedupeTargets) {
          changeLogs.push({
            targetTable: "property_owners",
            targetId: t.id,
            fieldName: "_deleted_via_merge",
            oldValue: sourceFresh.id,
            newValue: null,
            source: "manual",
            changedBy: session.id,
          });
        }
        for (const t of moveTargets) {
          changeLogs.push({
            targetTable: "property_owners",
            targetId: t.id,
            fieldName: "ownerId",
            oldValue: sourceFresh.id,
            newValue: masterFresh.id,
            source: "manual",
            changedBy: session.id,
          });
        }

        if (changeLogs.length > 0) {
          await tx.changeLog.createMany({ data: changeLogs });
        }
      });
    } catch (e) {
      if (e instanceof Error && e.message === TX_BLOCKED_SENTINEL) {
        if (txNotFound) {
          throw new ApiError(404, "所有者が見つかりません", "NOT_FOUND");
        }
        const reasons = txBlockedReasons ?? [];
        return apiResponse(
          {
            error: {
              message: "統合条件を満たしていません",
              code: "MERGE_BLOCKED",
              blockReasons: reasons,
            },
          },
          statusFromReasons(reasons),
        );
      }
      throw e;
    }

    // AuditLog (transaction 外・PII フリー)
    await writeAuditLog({
      userId: session.id,
      action: "owner_correction_merge",
      targetTable: "owners",
      targetId: masterId,
      detail: {
        correctionType: "merge",
        dryRun: false,
        sourceOwnerId: sourceId,
        masterVersion: newMasterVersion,
        sourceVersion: newSourceVersion,
        propertyOwnersMoved,
        propertyOwnersDeduplicated,
        ownerMemosMoved,
        sourceArchived: true,
      },
    });

    return apiResponse({
      executed: true,
      masterId,
      masterVersion: newMasterVersion,
      sourceId,
      sourceVersion: newSourceVersion,
      result: {
        propertyOwnersMoved,
        propertyOwnersDeduplicated,
        ownerMemosMoved,
        sourceArchived: true,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
