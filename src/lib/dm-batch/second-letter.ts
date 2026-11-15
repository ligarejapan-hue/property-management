/**
 * 同じ所有者あての「2通目」を外す(2026-11-16 発注者決定)。宛名CSV(A)と売却DM(B)の作成で共用する。
 *
 * 手紙は「物件ごと・送付先の住所ごとに1通」なので、同じ所有者が送付可の物件を2つ持っていると、
 * 同じ宛先へ2通できていた(実機確認 2026-11-15)。
 *
 * 決まり(発注者決定):
 *  - 同じ所有者が、送付可(アーカイブでない)の物件を複数持っているときは、**登録がいちばん新しい物件**の
 *    手紙だけを残す。ほかの物件の、その所有者が入っている宛先(代表でも共有者でも)は外す。
 *  - 外した結果、その物件の宛先が1つも残らなければ、その物件の DM判断を「送付不可」にする
 *    (demoteSecondLetterProperties)。次からは最初から対象に入らない。
 *
 * ⚠比べる相手は「いま作っている控え・発送の中」ではなく、**システム全体の送付可の物件**。
 *   売却DMは1回50通までなので、もう一方の物件が今回の対象に入っていないことがある
 *   (DM判断の自動仕分け dm-owner-judge の「同じ所有者がほかの物件で送付可」と同じ見方)。
 * ⚠同じ所有者=同じ所有者の行(id)。同じ宛先グループの人は同じ住所なので、共有者の1人が
 *   新しい物件を持っていれば、その宛先グループごと外す(その住所には新しい物件の手紙が届く)。
 * ⚠拒否・宛先不明・業者と同じ名前・外字(terminal-exclusion.ts)が先。両方に当たるときは、そちらの理由で数える。
 * ⚠氏名・住所は読まない(id と物件の登録日時だけ)。
 */

import prisma from "@/lib/prisma";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { isResourceEditLocked } from "@/lib/edit-lock/service";

/** 所有者と、その人が持つ送付可の物件(1行=1つながり)。 */
export interface SendPropertyLink {
  ownerId: string;
  propertyId: string;
  createdAt: Date;
}

/**
 * 所有者ごとの「手紙を残す物件」=登録がいちばん新しい送付可の物件。
 * 登録日時が同じなら id の大きいほう(毎回同じ結果にするため)。
 */
export function keptPropertyByOwner(links: readonly SendPropertyLink[]): Map<string, string> {
  const best = new Map<string, { propertyId: string; at: number }>();
  for (const l of links) {
    const at = l.createdAt.getTime();
    const cur = best.get(l.ownerId);
    if (!cur || at > cur.at || (at === cur.at && l.propertyId > cur.propertyId)) {
      best.set(l.ownerId, { propertyId: l.propertyId, at });
    }
  }
  return new Map([...best].map(([ownerId, v]) => [ownerId, v.propertyId]));
}

/**
 * この宛先が「2通目」か。ownerIds には**代表と共有者の両方**を渡す。
 * 所有者の誰かに、もっと新しい送付可の物件(=手紙を残す物件がこの物件でない)があれば 2通目。
 * 手紙を残す物件が分からない所有者(送付可の物件が見つからない)は、外す理由にしない。
 */
export function isSecondLetter(
  kept: ReadonlyMap<string, string>,
  item: { propertyId: string; ownerIds: readonly string[] },
): boolean {
  return item.ownerIds.some((id) => {
    const k = kept.get(id);
    return k !== undefined && k !== item.propertyId;
  });
}

/**
 * いま作っている控え・発送の宛先のうち、どれが「2通目」か(純関数)。戻り値は letters と同じ並びの真偽。
 *
 * 宛先の所有者の誰かに、もっと新しい送付可の物件があり、**その物件からその人に手紙が届く**ときだけ 2通目。
 *  - 新しい物件が今回の対象に入っていない → 届くものとして扱う(別の回で作る・作った)。
 *  - 新しい物件が今回の対象に入っている → その物件の、その人が入った宛先が残るときだけ「届く」。
 *    ⚠これを見ないと、共有者でつながった3物件で、誰にも届かないのに外れる(提出前レビュー):
 *      物件 A(X と Y の共有)・B(X だけ・A より古い)・C(Y だけ・いちばん新しい)のとき、
 *      A は Y の C があるので外れる。B を「X には新しい A がある」で外すと、X には1通も届かない。
 *  - eligible=false(拒否・宛先不明・業者と同じ名前・外字・所有者のつながりが変わった)の宛先は 2通目にしない
 *    (そちらの理由で数える)。その宛先からは手紙が届かないので、ほかの宛先を外す理由にもならない。
 * 新しい物件から順に決めるので、「届くか」は必ず先に決まっている。
 */
export function pickSecondLetters(
  letters: ReadonlyArray<{ propertyId: string; ownerIds: readonly string[]; eligible: boolean }>,
  links: readonly SendPropertyLink[],
): boolean[] {
  const atOf = new Map<string, number>();
  const byOwner = new Map<string, Array<{ propertyId: string; at: number }>>();
  for (const l of links) {
    const at = l.createdAt.getTime();
    atOf.set(l.propertyId, at);
    const list = byOwner.get(l.ownerId) ?? [];
    list.push({ propertyId: l.propertyId, at });
    byOwner.set(l.ownerId, list);
  }
  const inRun = new Set(letters.map((l) => l.propertyId));
  const delivered = new Set<string>();
  const key = (propertyId: string, ownerId: string) => `${propertyId}\u0000${ownerId}`;
  const isNewer = (c: { propertyId: string; at: number }, propertyId: string, at: number) =>
    c.propertyId !== propertyId && (c.at > at || (c.at === at && c.propertyId > propertyId));

  const second = letters.map(() => false);
  // 新しい物件から(登録日時の降順・同じなら id の降順)。登録日時が分からない物件(送付可の一覧に無い)は最後。
  const order = letters
    .map((_, i) => i)
    .sort((a, b) => {
      const pa = letters[a].propertyId;
      const pb = letters[b].propertyId;
      const ta = atOf.get(pa) ?? -Infinity;
      const tb = atOf.get(pb) ?? -Infinity;
      if (ta !== tb) return tb - ta;
      return pa === pb ? 0 : pa > pb ? -1 : 1;
    });
  for (const i of order) {
    const l = letters[i];
    if (!l.eligible) continue;
    const at = atOf.get(l.propertyId);
    if (at !== undefined) {
      second[i] = l.ownerIds.some((o) =>
        (byOwner.get(o) ?? []).some(
          (c) => isNewer(c, l.propertyId, at) && (!inRun.has(c.propertyId) || delivered.has(key(c.propertyId, o))),
        ),
      );
    }
    if (!second[i]) for (const o of l.ownerIds) delivered.add(key(l.propertyId, o));
  }
  return second;
}

/** tx に要求する最小の形(実 Prisma tx / route テストの mock の両方が満たす)。 */
export interface SecondLetterTx {
  propertyOwner: {
    findMany(args: {
      where: {
        ownerId: { in: string[] };
        owner: { isArchived: false };
        property: { dmStatus: "send"; isArchived: false };
      };
      select: { ownerId: true; propertyId: true; property: { select: { createdAt: true } } };
    }): Promise<Array<{ ownerId: string; propertyId: string; property: { createdAt: Date } }>>;
  };
}

/** 所有者たちが持つ送付可の物件を、システム全体から引く。所有者が空なら DB を引かない。 */
export async function findSendPropertyLinks(
  tx: SecondLetterTx,
  ownerIds: readonly string[],
): Promise<SendPropertyLink[]> {
  const owners = [...new Set(ownerIds)].sort();
  if (owners.length === 0) return [];
  const rows = await tx.propertyOwner.findMany({
    where: {
      ownerId: { in: owners },
      owner: { isArchived: false },
      property: { dmStatus: "send", isArchived: false },
    },
    select: { ownerId: true, propertyId: true, property: { select: { createdAt: true } } },
  });
  return rows.map((r) => ({ ownerId: r.ownerId, propertyId: r.propertyId, createdAt: r.property.createdAt }));
}

/** 所有者ごとの「手紙を残す物件」を、システム全体の送付可の物件から引く。 */
export async function findKeptPropertyByOwner(
  tx: SecondLetterTx,
  ownerIds: readonly string[],
): Promise<Map<string, string>> {
  return keptPropertyByOwner(await findSendPropertyLinks(tx, ownerIds));
}

/**
 * 宛先が1つも残らなかった物件(2通目として外した宛先がある)を選ぶ(純関数)。
 * items=この控え・発送で扱った宛先。outcome: "kept"=残した / "second"=2通目として外した /
 * "other"=ほかの理由(拒否・宛先不明・業者と同じ名前・外字)で外した / "unknown"=作らなかったが理由が別(所有者のつながりが変わった等)。
 * ⚠"kept" か "unknown" が1つでもある物件は選ばない(送る相手が残っている・状態が動いている最中かもしれない)。
 */
export type LetterOutcome = "kept" | "second" | "other" | "unknown";

export function propertiesToDemote(
  items: ReadonlyArray<{ propertyId: string; outcome: LetterOutcome }>,
): string[] {
  const byProperty = new Map<string, { second: boolean; blocked: boolean }>();
  for (const it of items) {
    const cur = byProperty.get(it.propertyId) ?? { second: false, blocked: false };
    if (it.outcome === "second") cur.second = true;
    if (it.outcome === "kept" || it.outcome === "unknown") cur.blocked = true;
    byProperty.set(it.propertyId, cur);
  }
  return [...byProperty]
    .filter(([, v]) => v.second && !v.blocked)
    .map(([id]) => id)
    .sort();
}

/**
 * 2通目として宛先がすべて外れた物件の DM判断を「送付不可」にする。控え・発送の保存が**済んだあと**に呼ぶ
 * (保存の tx は物件を共有ロックで持っているので、その中で書くと並行の作成どうしで待ち合いになる)。
 *
 * 1件ずつ、物件の行をロックしてから今の状態を読み直す(dm-owner-judge/service.ts と同じ形):
 *  - いまも送付可・アーカイブでない・所有者の誰かにもっと新しい送付可の物件がある、のときだけ書く
 *    (どの物件を渡すかは pickSecondLetters と propertiesToDemote が決める。ここは状態が変わっていないかの確かめ直し)。
 *  - 誰かが物件を編集中(編集の鍵がある)なら書かない(その人の保存を止めない)。次に作るときにまた外れ、また試す。
 *  - DM判断は編集画面が送る項目なので版(version)を上げる。変更履歴は「自動」(source=auto)・記録上の人=作った人。
 * 失敗しても控え・発送は出来ているので、例外は呑んで数えない(次に作るときにまた試す)。
 * 戻り値=「送付不可」にした物件数。
 */
export async function demoteSecondLetterProperties(
  propertyIds: readonly string[],
  changedBy: string,
): Promise<number> {
  let changed = 0;
  for (const propertyId of [...new Set(propertyIds)].sort()) {
    try {
      const done = await prisma.$transaction(async (tx) => {
        await lockPropertyRow(tx, propertyId);
        const p = await tx.property.findUnique({
          where: { id: propertyId },
          select: {
            dmStatus: true,
            isArchived: true,
            propertyOwners: { where: { owner: { isArchived: false } }, select: { ownerId: true } },
          },
        });
        if (!p || p.isArchived || p.dmStatus !== "send") return false;
        const ownerIds = p.propertyOwners.map((o) => o.ownerId);
        const kept = await findKeptPropertyByOwner(tx as unknown as SecondLetterTx, ownerIds);
        if (!isSecondLetter(kept, { propertyId, ownerIds })) return false;
        if (await isResourceEditLocked(tx, { resourceType: "property", resourceId: propertyId })) return false;
        await tx.property.update({
          where: { id: propertyId },
          data: { dmStatus: "no_send", version: { increment: 1 } },
        });
        await tx.changeLog.create({
          data: {
            targetTable: "properties",
            targetId: propertyId,
            fieldName: "dmStatus",
            oldValue: "send",
            newValue: "no_send",
            source: "auto",
            changedBy,
          },
        });
        return true;
      });
      if (done) changed += 1;
    } catch {
      // 控え・発送は出来ている。ここで落ちても作り直しにしない(次に作るときにまた外れ、また試す)。
    }
  }
  return changed;
}
