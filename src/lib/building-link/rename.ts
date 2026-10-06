/**
 * 棟の名前を、つながっている全部屋の物件名へ反映する(D3・D11・設計 §6.3)。
 * ⚠ロック順(システム全体の規則): **部屋の行 → 棟の行**。販売図面の書き戻し(sales-sheets/new)も
 *   この向き。棟の行を持ったまま部屋の行を待つ処理を作らない(待ちの輪=40P01 になる)。
 *   棟の行は `FOR NO KEY UPDATE`(`lockBuildingRowNoKeyUpdate`)で取る。理由は row-locks.ts。
 * ⚠誰かが部屋を編集中(編集中の鍵)なら反映せず止める。誰が編集中かは返さない(件数だけ)。
 * ⚠このファイルは画面(クライアント)からも読む。prisma は**型**しか import しない
 *   (`@/lib/edit-lock/rules` は定数だけの純モジュール)。実行時に prisma を持ち込まないこと。
 * ⚠アーカイブ済みの部屋も対象に含める(棟とのつながりは残っており、名前だけ古く残さない)。
 */
import type { Prisma } from "@/generated/prisma";
import { canAccessPropertyRecord } from "@/lib/property-access";
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
 * 棟の名前の反映のトランザクションが「重なって」落ちたか(待ちの輪 40P01・Prisma の P2034・
 * トランザクションの時間切れ P2028)。もう一度保存すれば通るので、500 ではなく再試行の案内にする。
 */
export function isRetryableTxError(e: unknown): boolean {
  const err = e as { code?: unknown; meta?: { code?: unknown }; cause?: { code?: unknown; originalCode?: unknown } } | null;
  const codes = [err?.code, err?.meta?.code, err?.cause?.code, err?.cause?.originalCode];
  return codes.some((c) => c === "P2028" || c === "P2034" || c === "40P01");
}

/** 棟の部屋の行(ロック済みの読み取り)。 */
export interface LockedUnit {
  id: string;
  buildingName: string | null;
  createdBy: string;
  assignedTo: string | null;
}

/**
 * 棟につながっている部屋の行を、ロックしながら読む(`FOR UPDATE`・id 順)。
 * 以降の「担当外の確認」「編集中の鍵の確認」「反映」は**このとき読んだ行だけ**を対象にする。
 * 別々に読み直すと、確認と反映の間につながった/担当が変わった部屋が確認を素通りして書き換わる。
 * ⚠ロック順は 部屋の行(id 順) → 棟の行(呼び出し側が続けて FOR NO KEY UPDATE)。
 *   他の処理との関係: 販売図面の書き戻しは 部屋 → 棟 で同じ向き。apply.ts(物件の保存側)は
 *   棟の行を待たない(`FOR UPDATE SKIP LOCKED` と外部キーの `FOR KEY SHARE` だけ。
 *   KEY SHARE は NO KEY UPDATE と衝突しない)。棟の写真の API は棟の行だけを取り、部屋の行は
 *   持たない。棟の行を先に取って部屋の行を待つ処理は無い(確認済み)。
 * ⚠ロックのあとにこの棟へつながった部屋は、今回は直らず、次にその部屋を保存したときに
 *   棟の名前にそろう(許容。権限の穴ではない: 担当外の部屋を書き換えてはいない)。
 */
export async function lockBuildingUnits(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  buildingId: string,
): Promise<LockedUnit[]> {
  return tx.$queryRaw<LockedUnit[]>`
    SELECT "id", "building_name" AS "buildingName", "created_by" AS "createdBy", "assigned_to" AS "assignedTo"
    FROM "properties"
    WHERE "building_id" = ${buildingId}::uuid
    ORDER BY "id"
    FOR UPDATE
  `;
}

/**
 * 担当外の部屋(field_staff 用)。物件の編集 API と同じ規則(`canAccessPropertyRecord`)を
 * ロック済みの行へ当てる。担当だけ見られる役割でなければ常に空。
 */
export function unitsOutsideScope(
  units: LockedUnit[],
  session: { id: string; role: string },
): LockedUnit[] {
  return units.filter((u) => !canAccessPropertyRecord(session, u));
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
  input: { units: LockedUnit[]; newName: string; userId: string },
): Promise<{ updated: number; changeLogs: RenameChangeLog[] }> {
  // ⚠物件名が null の部屋も直す(`!==` なので null は常に対象)。
  const targets = input.units.filter((u) => u.buildingName !== input.newName);
  if (targets.length === 0) return { updated: 0, changeLogs: [] };
  const res = await tx.property.updateMany({
    where: { id: { in: targets.map((u) => u.id) } },
    data: { buildingName: input.newName, version: { increment: 1 } },
  });
  return {
    updated: res.count,
    changeLogs: targets.map((u) => ({
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
