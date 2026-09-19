import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, apiResponse, getApiSession, handleApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { forceReleaseEditLock } from "@/lib/edit-lock/service";

const schema = z.object({
  resourceType: z.enum(["property", "owner"]),
  resourceId: z.string().uuid(),
  lockId: z.string().uuid(),
});

/**
 * 管理者による強制解除。admin だけが呼べる。
 * ⚠取得(acquire)と同じロック順序(所有者 → 物件の親行)で資源の行をロックしてから呼ぶ。
 */
export async function POST(request: Request) {
  try {
    const session = await getApiSession();
    if (session.role !== "admin") {
      throw new ApiError(403, "管理者のみ実行できます", "FORBIDDEN");
    }
    const { resourceType, resourceId, lockId } = schema.parse(await request.json());

    const result = await prisma.$transaction(async (tx) => {
      if (resourceType === "property") {
        await lockPropertyRow(tx, resourceId);
      } else {
        await tx.$queryRaw`SELECT id FROM owners WHERE id = ${resourceId}::uuid FOR UPDATE`;
      }
      return forceReleaseEditLock(tx, { resourceType, resourceId, lockId, adminUserId: session.id });
    });

    if (!result) {
      // ⚠取得(acquire)の「held」応答と同じ流儀: 業務上の状態(世代不一致)は
      //   ApiError/handleApiError を経由させず、直接 apiResponse で返す。
      return apiResponse({ code: "EDIT_LOCK_CHANGED" }, 409);
    }

    await writeAuditLog({
      userId: session.id,
      action: "edit_lock_force_release",
      targetTable: "edit_locks",
      targetId: lockId,
      detail: { resourceType, resourceId, previousUserId: result.previousUserId },
    });

    return apiResponse({ ok: true, previousUserId: result.previousUserId });
  } catch (error) {
    return handleApiError(error);
  }
}
