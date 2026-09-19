import { z } from "zod";
import prisma from "@/lib/prisma";
import { apiResponse, getApiSession, getUserPermissions, handleApiError } from "@/lib/api-helpers";
import { readEditLocks, type Target } from "@/lib/edit-lock/service";
import { readScreenTokenHash } from "@/lib/edit-lock/screen-token";
import { evaluateLock, type EditLockRow } from "@/lib/edit-lock/rules";
import { hasPermission } from "@/lib/permissions";
import { canAccessPropertyRecord } from "@/lib/property-access";

const schema = z.object({
  resources: z
    .array(
      z.object({
        resourceType: z.enum(["property", "owner"]),
        resourceId: z.string().uuid(),
      }),
    )
    .max(50),
});

/**
 * 一覧・カード表示向けの状態照会。**閲覧権限のある資源だけ**を返す
 * (物件=property:read+担当範囲、所有者=owner:read)。取得(acquire)と違い
 * 書き込み権限は要求しない(表示だけなら見られてよい)。
 * `lockId` は管理者にだけ含める(取得の世代を admin 以外に渡さない)。
 */
export async function POST(request: Request) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    const { resources } = schema.parse(await request.json());
    // 一覧表示にはタブ固有の合言葉が無いことが多い。無ければ、どの鍵とも一致しない
    // 空文字を渡す(service.ts の assertNotEditLockedByOther と同じフォールバック)。
    const screenTokenHash = readScreenTokenHash(request) ?? "";

    const propertyIds = resources.filter((r) => r.resourceType === "property").map((r) => r.resourceId);

    const canViewOwner = hasPermission(perms, "owner", "read");
    const canReadProperty = hasPermission(perms, "property", "read");
    const properties = canReadProperty && propertyIds.length > 0
      ? await prisma.property.findMany({
          where: { id: { in: propertyIds } },
          select: { id: true, createdBy: true, assignedTo: true },
        })
      : [];
    const propertyById = new Map(properties.map((p) => [p.id, p]));

    const visible: Target[] = [];
    for (const r of resources) {
      if (r.resourceType === "owner") {
        if (canViewOwner) visible.push(r);
        continue;
      }
      const property = propertyById.get(r.resourceId);
      if (property && canAccessPropertyRecord(session, property)) {
        visible.push(r);
      }
    }

    const { dbNow, locks } = await readEditLocks(prisma, visible);
    const lockByKey = new Map(locks.map((l) => [`${l.resourceType}:${l.resourceId}`, l]));

    const isAdmin = session.role === "admin";
    // held_by_other の氏名をまとめて1回で引く。
    const holderIds = new Set<string>();
    const evaluated = visible.map((r) => {
      const lock: EditLockRow | null = lockByKey.get(`${r.resourceType}:${r.resourceId}`) ?? null;
      const state = evaluateLock(lock, dbNow, { userId: session.id, screenTokenHash });
      if (state.state === "held_by_other") holderIds.add(state.holderUserId);
      return { r, state };
    });
    const holders = holderIds.size > 0
      ? await prisma.user.findMany({ where: { id: { in: [...holderIds] } }, select: { id: true, name: true } })
      : [];
    const holderNameById = new Map(holders.map((h) => [h.id, h.name]));

    const results = evaluated.map(({ r, state }) => {
      const base = { resourceType: r.resourceType, resourceId: r.resourceId };
      switch (state.state) {
        case "mine":
        case "held_by_self_other_screen":
          return { ...base, state: state.state, since: state.since, ...(isAdmin ? { lockId: state.lockId } : {}) };
        case "held_by_other":
          return {
            ...base,
            state: state.state,
            since: state.since,
            holderName: holderNameById.get(state.holderUserId) ?? "他の利用者",
            ...(isAdmin ? { lockId: state.lockId } : {}),
          };
        // ⚠墓標(force_released_mine)は期限切れ・空と同じ "free" として返す
        //   (状態画面は「管理者に外された」を出す専用の場ではない)。
        case "force_released_mine":
        case "free":
        default:
          return { ...base, state: "free" as const };
      }
    });

    return apiResponse({ locks: results });
  } catch (error) {
    return handleApiError(error);
  }
}
