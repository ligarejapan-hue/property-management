import { z } from "zod";
import prisma from "@/lib/prisma";
import { apiResponse, getApiSession, getUserPermissions, handleApiError } from "@/lib/api-helpers";
import { readEditLocks, type Target } from "@/lib/edit-lock/service";
import { readScreenTokenHash } from "@/lib/edit-lock/screen-token";
import { evaluateLock, EDIT_LOCK_STATUS_CHUNK_SIZE, type EditLockRow } from "@/lib/edit-lock/rules";
import { hasPermission } from "@/lib/permissions";
import { canAccessPropertyRecord } from "@/lib/property-access";

const schema = z.object({
  resources: z
    .array(
      z.object({
        resourceType: z.enum(["property", "owner"]),
        // ⚠uuid の大文字/小文字違い(@codex P2・2026-09-21指摘・R6/readLockId に続く3件目):
        //   `z.string().uuid()` は大文字混じりの UUID も受理するが、Postgres は
        //   uuid 列を常に正規の小文字表記で返す。検証の**この場で**小文字化しておかないと、
        //   `propertyById` も鍵の照合キーも「リクエストの元値」と「DB が返す値」で
        //   食い違い、保持中の鍵が free と誤報される・物件が結果から丸ごと消える。
        resourceId: z
          .string()
          .uuid()
          .transform((v) => v.toLowerCase()),
      }),
    )
    .max(EDIT_LOCK_STATUS_CHUNK_SIZE),
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
    const ownerIds = resources.filter((r) => r.resourceType === "owner").map((r) => r.resourceId);

    const canViewOwner = hasPermission(perms, "owner", "read");
    const canReadProperty = hasPermission(perms, "property", "read");
    const isAdmin = session.role === "admin";
    // ⚠M3改定(2026-09-21・@codex 提案・受入済): 管理者は引き続き isArchived で
    //   絞らない。acquire/heartbeat はアーカイブ済み資源への操作を404で塞ぐが、
    //   status はその逆で**管理者がアーカイブ済み資源に残った孤児鍵を見つけて
    //   force-release できる唯一の窓口**として機能している。この救済路は残す。
    //   ただし一般利用者にまでこの窓を開けておく理由は無い:
    //   アーカイブ済み(=既に使われていない)資源の保持者名(holderName)を
    //   一般利用者に見せる意味は無く、むしろ余計な個人情報の露出になる
    //   (M3 の元の裁定は「絞らない」の理由が救済路の温存だけだったので、
    //   一般利用者を絞ることとは矛盾しない)。よって**管理者は絞らず、
    //   一般利用者だけ isArchived=false かつ実在する資源に絞る**。
    const properties = canReadProperty && propertyIds.length > 0
      ? await prisma.property.findMany({
          where: { id: { in: propertyIds } },
          select: { id: true, createdBy: true, assignedTo: true, isArchived: true },
        })
      : [];
    const propertyById = new Map(properties.map((p) => [p.id, p]));

    // 所有者は従来ここで存在確認を一切していなかった(owner:read さえあれば
    // どんな uuid でも visible にしていた)。アーカイブ済み/存在しない所有者の
    // 鍵の保持者名まで一般利用者に見せてしまうため、物件と同じ形で存在+
    // アーカイブを確認する。
    const owners = canViewOwner && ownerIds.length > 0
      ? await prisma.owner.findMany({
          where: { id: { in: ownerIds } },
          select: { id: true, isArchived: true },
        })
      : [];
    const ownerById = new Map(owners.map((o) => [o.id, o]));

    const visible: Target[] = [];
    for (const r of resources) {
      if (r.resourceType === "owner") {
        if (!canViewOwner) continue;
        const owner = ownerById.get(r.resourceId);
        if (!owner) continue;
        if (!isAdmin && owner.isArchived) continue;
        visible.push(r);
        continue;
      }
      const property = propertyById.get(r.resourceId);
      if (!property || !canAccessPropertyRecord(session, property)) continue;
      if (!isAdmin && property.isArchived) continue;
      visible.push(r);
    }

    const { dbNow, locks } = await readEditLocks(prisma, visible);
    const lockByKey = new Map(locks.map((l) => [`${l.resourceType}:${l.resourceId}`, l]));
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
