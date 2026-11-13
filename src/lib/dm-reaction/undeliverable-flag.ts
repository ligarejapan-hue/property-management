/**
 * 物件の「宛先不明」の印(dmUndeliverableAt)を残すかどうかの数え方(1か所にまとめる)。
 *
 * 印を残す理由になるのは次の2つ。どちらも 0 なら印を外してよい。
 *  ① その物件の DM の記録のうち、**解除していない**宛先不明
 *  ② その物件の売却DMの宛先(送付済み)のうち、返戻(returned_undeliverable)のもの
 *     ⚠②は、つながっている記録(draftId)の宛先不明が解除済みなら数えない(2026-11-13)。
 *       売却DMの宛先不明は「宛先の返戻」と「記録の宛先不明」の2か所に載る。記録だけ解除しても
 *       宛先の返戻が残って数えられると、印が外れず DM 可否も戻らない。
 *
 * ⚠今までは反響の変更・記録の削除・売却DMの結果の3か所が同じ数え方を別々に書いていた。
 *   宛先不明の解除(住所を替えたとき)を足すにあたり、ここに一本化する(同じ条件を複数に書くとずれる)。
 * ⚠呼ぶ側が物件の行を押さえたトランザクションの中で呼ぶ。
 */
import { activeUndeliverableLogWhere } from "@/lib/dm-reaction/core";

export interface UndeliverableFlagTx {
  propertyDmLog: {
    findMany(args: {
      where: {
        propertyId: string;
        reactionStatus: "undeliverable";
        undeliverableClearedAt: { not: null };
        draftId: { not: null };
      };
      select: { draftId: true };
    }): Promise<Array<{ draftId: string | null }>>;
    count(args: {
      where: {
        propertyId: string;
        reactionStatus: "undeliverable";
        undeliverableClearedAt: null;
        id?: { not: string };
      };
    }): Promise<number>;
  };
  dmRecipientDraft: {
    count(args: {
      where: {
        propertyId: string;
        status: "sent";
        deliveryStatus: "returned_undeliverable";
        id: { notIn: string[] };
      };
    }): Promise<number>;
  };
}

/**
 * その物件に残っている宛先不明の数(記録+売却DMの宛先)。0 なら物件の印を外してよい。
 * @param exclude.logId   数えない記録(今まさに変える・消す記録)
 * @param exclude.draftId 数えない売却DMの宛先(今まさに結果を変える宛先)
 */
export async function countActiveUndeliverable(
  tx: UndeliverableFlagTx,
  propertyId: string,
  exclude: { logId?: string; draftId?: string } = {},
): Promise<number> {
  // 解除済みの記録につながる売却DMの宛先は数えない
  const clearedBridged = await tx.propertyDmLog.findMany({
    where: {
      propertyId,
      reactionStatus: "undeliverable",
      undeliverableClearedAt: { not: null },
      draftId: { not: null },
    },
    select: { draftId: true },
  });
  const skipDraftIds = [
    ...new Set([
      ...clearedBridged.map((l) => l.draftId).filter((id): id is string => !!id),
      ...(exclude.draftId ? [exclude.draftId] : []),
    ]),
  ].sort();
  const [logCount, draftCount] = await Promise.all([
    tx.propertyDmLog.count({
      where: {
        propertyId,
        ...activeUndeliverableLogWhere(),
        ...(exclude.logId ? { id: { not: exclude.logId } } : {}),
      },
    }),
    tx.dmRecipientDraft.count({
      where: {
        propertyId,
        status: "sent",
        deliveryStatus: "returned_undeliverable",
        id: { notIn: skipDraftIds },
      },
    }),
  ]);
  return logCount + draftCount;
}
