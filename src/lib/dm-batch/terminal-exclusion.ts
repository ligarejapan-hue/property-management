/**
 * 拒否・宛先不明(terminal 反響)の付いた宛先を送付対象から外すための、
 * **唯一の**除外セット構築・判定。
 *
 * ⚠なぜ 1 本化するか: 2026-08-16、宛名CSV(A)には入っていたこの除外が
 * 売却DM(B)に**入っていない**穴が見つかった([[dm-sending-management]])。
 * 「一度お断りをいただいた方へもう一度手紙が作られる」は業務上いちばん
 * 避けたい間違いで、同じ条件を 2 か所に書けば必ずまたずれる。
 * 集合の作り方(3経路のOR)と判定を、A/B 両方がこのモジュールから使う。
 *
 * 3経路(@codex #366 R4 P1 / R6):
 *  ① 代表 owner_id が terminal — その所有者は**どの物件宛でも**外す(所有者横断)
 *  ② 共有者連関 log_owners に terminal — 共有名義の誰かが断った場合も外す
 *  ③ 所有者に紐づかない terminal(物件の個別記録の拒否など) — その**物件**を外す
 *
 * ⚠呼び出し側の義務: この照会は **Owner FOR SHARE を保持した tx の中**で行う
 * (terminal を書く側は Owner FOR UPDATE を取る=直列化される・@codex R47)。
 * ロック無しで呼ぶと、除外の読み取りと terminal 記録の書き込みが競合する。
 */

import { TERMINAL_REACTIONS } from "@/lib/dm-reaction/core";

// ⚠集合の正本は dm-reaction/core.ts(書き込み側=Owner FOR UPDATE の要否を決める側)。
// 提出前レビューで「このファイルが2つ目の定義になっている」ことを指摘された。
// 読む側と書く側で集合がずれると、除外漏れ(今回の穴の再発)か直列化崩れが起きる。

export interface TerminalExclusionSets {
  /** この所有者が絡む宛先グループは除外(所有者横断)。 */
  ownerIds: Set<string>;
  /** 所有者に紐づかない terminal を持つ物件(物件単位で除外)。 */
  propertyIds: Set<string>;
}

interface TerminalLogRow {
  ownerId: string | null;
  propertyId: string | null;
  logOwners: { ownerId: string }[];
}

/** tx に要求する最小の形(実 Prisma tx / route テストの mock の両方が満たす)。 */
export interface TerminalExclusionTx {
  propertyDmLog: {
    findMany(args: {
      where: {
        reactionStatus: { in: string[] };
        OR: unknown[];
      };
      select: {
        ownerId: true;
        propertyId: true;
        logOwners: { select: { ownerId: true } };
      };
    }): Promise<TerminalLogRow[]>;
  };
}

const sortUnique = (ids: readonly string[]): string[] => [...new Set(ids)].sort();

/**
 * terminal 反響から除外セットを作る。両方空なら DB を引かない(A の既存ガードを継承)。
 */
export async function findTerminalExclusions(
  tx: TerminalExclusionTx,
  ownerIds: readonly string[],
  propertyIds: readonly string[],
): Promise<TerminalExclusionSets> {
  const sets: TerminalExclusionSets = { ownerIds: new Set(), propertyIds: new Set() };
  const owners = sortUnique(ownerIds);
  const properties = sortUnique(propertyIds);
  if (owners.length === 0 && properties.length === 0) return sets;

  const terminalLogs = await tx.propertyDmLog.findMany({
    where: {
      reactionStatus: { in: [...TERMINAL_REACTIONS] },
      OR: [
        { ownerId: { in: owners } },
        { logOwners: { some: { ownerId: { in: owners } } } },
        {
          propertyId: { in: properties },
          ownerId: null,
          logOwners: { none: {} },
        },
      ],
    },
    select: {
      ownerId: true,
      propertyId: true,
      logOwners: { select: { ownerId: true } },
    },
  });
  for (const log of terminalLogs) {
    if (log.ownerId || log.logOwners.length > 0) {
      if (log.ownerId) sets.ownerIds.add(log.ownerId);
      for (const lo of log.logOwners) sets.ownerIds.add(lo.ownerId);
    } else if (log.propertyId) {
      sets.propertyIds.add(log.propertyId);
    }
  }
  return sets;
}

/**
 * 宛先グループを除外すべきか。ownerIds には**代表と共有者の両方**を渡す
 * (A: `[it.ownerId, ...it.groupOwnerIds]` / B: `[代表, ...groupOwnerIds]`)。
 */
export function isTerminalExcluded(
  sets: TerminalExclusionSets,
  item: { propertyId: string; ownerIds: readonly string[] },
): boolean {
  return (
    item.ownerIds.some((id) => sets.ownerIds.has(id)) ||
    sets.propertyIds.has(item.propertyId)
  );
}
