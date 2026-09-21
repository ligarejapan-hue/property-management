import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, apiResponse, getApiSession, handleApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { forceReleaseEditLock } from "@/lib/edit-lock/service";
import { lockOwnerRow } from "@/lib/edit-lock/row-locks";

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
        await lockOwnerRow(tx, resourceId);
      }
      return forceReleaseEditLock(tx, { resourceType, resourceId, lockId, adminUserId: session.id });
    });

    if (!result) {
      // ⚠H2: これは「状態」ではなく「エラー」(鍵の状態が変わった)なので、acquire の
      //   held(423・状態)とは違い ApiError/handleApiError の封筒 `{ error: { message, code } }`
      //   を経由させる。以前は裸の `{ code: "EDIT_LOCK_CHANGED" }` を直接返していたため、
      //   acquire 自身が投げる同じコード(service.ts の EDIT_LOCK_CHANGED)とここで
      //   応答の形が食い違い、クライアントが2種類の読み方を書き分けねばならなかった。
      throw new ApiError(409, "鍵の状態が変わりました。もう一度お試しください", "EDIT_LOCK_CHANGED");
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
