import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, apiResponse, getApiSession, getUserPermissions, handleApiError } from "@/lib/api-helpers";
import { heartbeatEditLock } from "@/lib/edit-lock/service";
import { readScreenTokenHash } from "@/lib/edit-lock/screen-token";
import { assertCanLockOwner, assertCanLockProperty } from "@/lib/edit-lock/permissions";
import { evaluateLock } from "@/lib/edit-lock/rules";

const schema = z.object({
  resourceType: z.enum(["property", "owner"]),
  resourceId: z.string().uuid(),
  active: z.boolean(),
});

/**
 * 合図(heartbeat)。⚠**資源の行はロックしない**(取得/管理者解除とは違い、書き込みではない)。
 * 期限・保持者の判定は必ず service が返した `dbNow` を `evaluateLock` に渡して行う
 * (アプリの時計で測り直さない)。監査は書かない(取得/横取り/解除/管理者解除だけが対象)。
 */
export async function POST(request: Request) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    const { resourceType, resourceId, active } = schema.parse(await request.json());
    const screenTokenHash = readScreenTokenHash(request);
    if (!screenTokenHash) {
      throw new ApiError(400, "画面の識別子がありません。画面を再読み込みしてください", "EDIT_SCREEN_REQUIRED");
    }

    // ⚠取得(acquire)と同じ理由で、閲覧権限の無い呼び出し元に保持者の氏名を渡さない
    // (assertCanLockProperty/assertCanLockOwner の doc comment 参照)。資源が既に無い
    // (アーカイブ側が鍵の後始末を済ませた等)ときは、下の heartbeatEditLock がそのまま
    // "行が無い" として lost/expired を返すので、ここでは弾かない。
    if (resourceType === "property") {
      const property = await prisma.property.findUnique({
        where: { id: resourceId },
        select: { createdBy: true, assignedTo: true, isArchived: true },
      });
      if (property && !property.isArchived) {
        assertCanLockProperty(session, perms, property);
      }
    } else {
      assertCanLockOwner(perms);
    }

    const result = await heartbeatEditLock(prisma, {
      resourceType,
      resourceId,
      userId: session.id,
      screenTokenHash,
      active,
    });
    if (result.ok) {
      return apiResponse({ state: "ok" });
    }

    // ⚠期限・保持者の分類は evaluateLock(lock, dbNow, requester) に一本化する
    //   (@codex R9 P2)。dbNow は service が返した値をそのまま使う。
    const state = evaluateLock(result.current, result.dbNow, { userId: session.id, screenTokenHash });
    if (state.state === "force_released_mine") {
      return apiResponse({ state: "lost", reason: "force_released" });
    }
    if (state.state === "free") {
      return apiResponse({ state: "lost", reason: "expired" });
    }
    if (state.state === "mine") {
      // 直前の UPDATE と本読み取りの間に生き返った(競合)。取り直しは不要。
      return apiResponse({ state: "ok" });
    }
    // held_by_other / held_by_self_other_screen: 他の画面が保持している。
    const holderUserId = state.state === "held_by_other" ? state.holderUserId : result.current!.userId;
    const [holder] = await prisma.user.findMany({
      where: { id: holderUserId },
      select: { id: true, name: true },
    });
    return apiResponse({ state: "taken", holderName: holder?.name ?? "他の利用者", since: state.since });
  } catch (error) {
    return handleApiError(error);
  }
}
