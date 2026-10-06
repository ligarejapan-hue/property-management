/**
 * 棟の名前を、つながっている全部屋の物件名へ反映する(D3・D11・設計 §6.3)。
 * ⚠ロック順: **棟の行 → 部屋の行**(apply.ts は棟の行をロックしないので逆順は無い)。
 * ⚠棟の行は `FOR NO KEY UPDATE`(`lockBuildingRowNoKeyUpdate`)で取る。理由は row-locks.ts。
 * ⚠誰かが部屋を編集中(編集中の鍵)なら反映せず止める。誰が編集中かは返さない(件数だけ)。
 * ⚠このファイルは画面(クライアント)からも読む。prisma は**型**しか import しない
 *   (`@/lib/edit-lock/rules` は定数だけの純モジュール)。実行時に prisma を持ち込まないこと。
 * ⚠アーカイブ済みの部屋も対象に含める(棟とのつながりは残っており、名前だけ古く残さない)。
 */
import type { Prisma } from "@/generated/prisma";
import { EDIT_LOCK_HEARTBEAT_GRACE_MS, EDIT_LOCK_IDLE_LIMIT_MS } from "@/lib/edit-lock/rules";

const GRACE_SEC = EDIT_LOCK_HEARTBEAT_GRACE_MS / 1000;
const IDLE_SEC = EDIT_LOCK_IDLE_LIMIT_MS / 1000;

export function isBuildingRename(oldName: string, newName: string | undefined): boolean {
  return newName !== undefined && newName.trim() !== oldName.trim();
}

export function renamePropagateConfirmMessage(oldName: string, newName: string, unitCount: number): string | null {
  if (unitCount <= 0 || !isBuildingRename(oldName, newName)) return null;
  return `部屋${unitCount}件の物件名も「${newName.trim()}」に直します。よろしいですか？`;
}

export async function countEditLockedUnits(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  buildingId: string,
): Promise<number> {
  // ⚠期限は DB の時計で見る(service.ts の assertNotEditLockedByOther と同じ式)。
  // ⚠make_interval の秒は ::double precision を明示(service.ts の注記と同じ理由)。
  const rows = await tx.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n
    FROM "edit_locks" l JOIN "properties" p ON p."id" = l."resource_id"
    WHERE l."resource_type" = 'property'::"EditLockResource"
      AND p."building_id" = ${buildingId}::uuid
      AND l."force_released_at" IS NULL
      AND l."heartbeat_at" >= clock_timestamp() - make_interval(secs => ${GRACE_SEC}::double precision)
      AND l."activity_at" >= clock_timestamp() - make_interval(secs => ${IDLE_SEC}::double precision)
  `;
  return rows[0]?.n ?? 0;
}

/**
 * 担当外の部屋の数(field_staff 用)。物件の編集 API(properties/[id])は、field_staff が
 * 「自分が作ってもいないし担当でもない」物件を直すのを禁じている。棟の名前の反映は部屋の
 * 物件名を書き換えるので、その禁止を迂回しないよう、1件でもあれば止める。
 * ⚠assignedTo は null があり得る。`assignedTo <> X` だけだと NULL を拾えないので OR で明示する。
 */
export async function countUnitsOutsideScope(
  tx: Pick<Prisma.TransactionClient, "property">,
  buildingId: string,
  userId: string,
): Promise<number> {
  return tx.property.count({
    where: {
      buildingId,
      createdBy: { not: userId },
      OR: [{ assignedTo: null }, { assignedTo: { not: userId } }],
    },
  });
}

export interface RenameChangeLog {
  targetTable: "properties";
  targetId: string;
  fieldName: "buildingName";
  oldValue: string | null;
  newValue: string;
  source: "manual";
  changedBy: string;
}

export async function propagateBuildingName(
  tx: Pick<Prisma.TransactionClient, "property">,
  input: { buildingId: string; newName: string; userId: string },
): Promise<{ updated: number; changeLogs: RenameChangeLog[] }> {
  const units = await tx.property.findMany({
    // ⚠`NOT: { buildingName: X }` だけだと物件名が null の部屋を拾わない(SQL の <> は NULL を除く)。
    where: {
      buildingId: input.buildingId,
      OR: [{ buildingName: null }, { NOT: { buildingName: input.newName } }],
    },
    select: { id: true, buildingName: true },
  });
  if (units.length === 0) return { updated: 0, changeLogs: [] };
  const res = await tx.property.updateMany({
    where: { id: { in: units.map((u) => u.id) } },
    data: { buildingName: input.newName, version: { increment: 1 } },
  });
  return {
    updated: res.count,
    changeLogs: units.map((u) => ({
      targetTable: "properties" as const,
      targetId: u.id,
      fieldName: "buildingName" as const,
      oldValue: u.buildingName,
      newValue: input.newName,
      source: "manual" as const,
      changedBy: input.userId,
    })),
  };
}
