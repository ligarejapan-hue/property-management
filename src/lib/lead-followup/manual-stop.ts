import type { Prisma } from "@/generated/prisma";

/**
 * 担当が押す「追客を止める」(設計 2026-11-16 §3.3 manual・§8 PR2)。止めたら終わり(再開なし・発注者 11-17)。
 * - 進行中(active/sending)の行があれば stopped/manual にする(取り合いは updateMany の状態の条件で)。
 * - 行がまだ無い(送信の仕組みが拾う前)ときは、止めた印の行を先に作る。物件・申込ごとに1行(UNIQUE)なので、
 *   送信の処理はこの行を見て始めない。アドレスは入れない(null)=同じアドレスの別の追客は止めない。
 * - すでに止まっている・送り終えた行は何もしない(already)。
 * - 作るのと送信の処理が行を作るのが同時でも取りこぼさないよう、
 *   止める → 無ければ作る(重複は無視) → もう一度止める、の順にする。
 * 呼び出し側の transaction の中で、親の物件行をロックしてから呼ぶ(R50)。
 */

export type FollowupStopTarget = { kind: "property"; propertyId: string } | { kind: "inquiry"; inquiryId: string };
export type FollowupStopResult = "stopped" | "created" | "already";

type Tx = Pick<Prisma.TransactionClient, "leadFollowup">;

function targetWhere(t: FollowupStopTarget) {
  return t.kind === "property" ? { propertyId: t.propertyId } : { inquiryId: t.inquiryId };
}

export async function stopFollowupManually(
  tx: Tx,
  target: FollowupStopTarget,
  userId: string,
  now: Date,
): Promise<FollowupStopResult> {
  const stopData = { status: "stopped", stopReason: "manual", stoppedAt: now, stoppedById: userId, claimedAt: null };
  const stopActive = () =>
    tx.leadFollowup.updateMany({
      where: { ...targetWhere(target), status: { in: ["active", "sending"] } },
      data: stopData,
    });

  if ((await stopActive()).count > 0) return "stopped";

  const created = await tx.leadFollowup.createMany({
    data: [
      {
        targetType: target.kind,
        ...targetWhere(target),
        emailNormalized: null,
        status: "stopped",
        stopReason: "manual",
        stoppedAt: now,
        stoppedById: userId,
      },
    ],
    skipDuplicates: true,
  });
  if (created.count > 0) return "created";

  // 作れなかった=行がある。その間に進行中の行ができていたら止める。
  if ((await stopActive()).count > 0) return "stopped";
  return "already";
}
