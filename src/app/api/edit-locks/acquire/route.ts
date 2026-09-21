import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, apiResponse, getApiSession, getUserPermissions, handleApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { acquireEditLock } from "@/lib/edit-lock/service";
import { readScreenTokenHash } from "@/lib/edit-lock/screen-token";
import { lockOwnerRow } from "@/lib/edit-lock/row-locks";
import { assertCanLockOwner, assertCanLockProperty } from "@/lib/edit-lock/permissions";

const schema = z.object({
  resourceType: z.enum(["property", "owner"]),
  resourceId: z.string().uuid(),
});

export async function POST(request: Request) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    const { resourceType, resourceId } = schema.parse(await request.json());
    const screenTokenHash = readScreenTokenHash(request);
    if (!screenTokenHash) {
      throw new ApiError(400, "画面の識別子がありません。画面を再読み込みしてください", "EDIT_SCREEN_REQUIRED");
    }

    const result = await prisma.$transaction(async (tx) => {
      // ロック順序: 所有者 → 物件の親行(既存規約)。保存・管理者解除と同じ順序で直列化する。
      // ⚠存在・アーカイブ・担当範囲の確認は**ロックの後**に行う(@codex R6 P2)。
      if (resourceType === "property") {
        await lockPropertyRow(tx, resourceId);
        // ⚠読み取りは**同じトランザクションの tx**で行う(base client=別コネクションでは
        //   行ロックが守っている状態を見られない。この直後にアーカイブ/担当変更が
        //   commit された場合、tx の再読み取りでなければそれを取りこぼし、
        //   消えた資源へ孤児の鍵を作ってしまう。設計 §4.2)。
        const property = await tx.property.findUnique({
          where: { id: resourceId },
          // ⚠`isArchived` も読む(@codex R10 P2)。読まないと、一覧から消えているアーカイブ済みの
          //   物件に対して、窓口を直接呼ぶだけで鍵を取り続けられる(所有者側は既に弾いている)。
          select: { createdBy: true, assignedTo: true, isArchived: true },
        });
        if (!property || property.isArchived) throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
        assertCanLockProperty(session, perms, property);
      } else {
        await lockOwnerRow(tx, resourceId);
        const owner = await tx.owner.findUnique({
          where: { id: resourceId },
          select: { id: true, isArchived: true },
        });
        if (!owner || owner.isArchived) throw new ApiError(404, "所有者が見つかりません", "NOT_FOUND");
        assertCanLockOwner(perms);
      }
      return acquireEditLock(tx, { resourceType, resourceId, userId: session.id, screenTokenHash });
    });

    if (result.state === "held") {
      const [holder] = await prisma.user.findMany({
        where: { id: result.current.userId },
        select: { id: true, name: true },
      });
      return apiResponse(
        {
          code: "EDIT_LOCKED",
          state: result.current.userId === session.id ? "held_by_self_other_screen" : "held_by_other",
          holderName: holder?.name ?? "他の利用者",
          since: result.current.acquiredAt,
        },
        423,
      );
    }

    // ⚠横取りの判定・原因は service が DB の now() で決めた値をそのまま使う(@codex R8 P2)。
    //   ここでアプリの時計で計算し直さない。
    await writeAuditLog({
      userId: session.id,
      action: result.takeover ? "edit_lock_takeover_expired" : "edit_lock_acquire",
      targetTable: "edit_locks",
      targetId: result.lockId,
      detail: result.takeover
        ? {
            resourceType,
            resourceId,
            previousUserId: result.takeover.previousUserId,
            expiredBy: result.takeover.expiredBy,
          }
        : { resourceType, resourceId },
    });

    return apiResponse({ state: "mine", lockId: result.lockId, since: result.since });
  } catch (error) {
    return handleApiError(error);
  }
}
