/**
 * 謄本の名義の確認(2026-11-08 発注者依頼): 比べて結果を残す・「このままでよい」・DM を戻す。
 *
 * ⚠表 registry_owner_checks には**結果と判断だけ**を残す(氏名・住所は保存しない)。
 * ⚠ロックの順序は 物件の行 → 結果の行(所有者の付け外しも物件の行を先に押さえ、
 *   トリガーが結果の行を書く=同じ順)。結果を書く前に物件の行を押さえ、結果の行を押さえてから
 *   今の所有者の氏名を読み直す(読んだあとに付け外しされて古い結果で「同じ」にしないため)。
 * ⚠残る小さな隙: 結果の行がまだ無い物件を**初めて**比べる瞬間に、別の処理が氏名の変更や謄本の
 *   削除をまだ確定していないと、トリガーは行が無いので印を立てられない(古い氏名で確定しうる)。
 *   所有者の行まで押さえると「所有者 → 物件」の順の窓口と逆順になり互いに待ち合うため、
 *   押さえない(初回の全件比べの最中に同じ物件の氏名を直す、という重なりだけで起きる)。
 */
import prisma from "@/lib/prisma";
import { ApiError } from "@/lib/api-helpers";
import { lockPropertyRecordForWrite, lockPropertyRow } from "@/lib/property-record-guard";
import { parseRegistryOwnerTable } from "@/lib/registry-owner-table";
import {
  findLatestOwnerRegistryAttachment,
  loadLatestRegistryText,
  SUPPORTED_CERTIFICATE_TYPE,
  type ReplaceTx,
} from "@/lib/registry-owner-apply/apply";
import { compareRegistryOwners, type RegistryOwnerCheckResult } from "@/lib/registry-owner-check/compare";
import { ownerDiff } from "@/lib/registry-owner-check/diff";

type Tx = ReplaceTx;

/** 1回の「比べる」で扱う上限(謄本を読むので重い)。 */
export const REGISTRY_OWNER_CHECK_RUN_MAX = 50;

/**
 * 謄本1件の文字を抜き出す時間の上限(2026-11-08 発注者依頼)。とても大きい PDF で、夜の自動の比べが
 * 2分ごとの呼び出しの持ち時間を食わないため。超えたら「読めない」で確定させず、思わぬ失敗と
 * 同じく比べ直し待ちのまま残す(前の結果も残す・夜は1時間あけて試し直す)。
 */
export const REGISTRY_OWNER_READ_TIMEOUT_MS = 20_000;

/** 謄本の名義を読む。読めなければ null。謄本が無ければ "none"。 */
async function readRegistryNames(
  propertyId: string,
): Promise<{ attachmentId: string; names: string[] | null } | "none"> {
  const latest = await findLatestOwnerRegistryAttachment(prisma, propertyId);
  if (!latest) return "none";
  try {
    const registry = await loadLatestRegistryText(propertyId, latest.id, {
      timeoutMs: REGISTRY_OWNER_READ_TIMEOUT_MS,
    });
    const owners = parseRegistryOwnerTable(registry.text);
    const names = owners?.map((o) => o.name).filter((n) => n && n.trim()) ?? [];
    return { attachmentId: latest.id, names: names.length > 0 ? names : null };
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    if (code === "REGISTRY_FILE_MISSING" || code === "REGISTRY_TEXT_UNREADABLE") {
      return { attachmentId: latest.id, names: null };
    }
    // 読んでいる間に別の謄本が付いた(=比べ直しの印が立つ)・消えた
    if (code === "REGISTRY_ATTACHMENT_CHANGED" || code === "REGISTRY_NOT_FOUND") return "none";
    // 時間切れ(REGISTRY_TEXT_TIMEOUT)・保存場所の故障などは投げる=呼び出し元が比べ直し待ちに残す
    throw e;
  }
}

/** 今つながっている所有者の氏名(トランザクションの中で読む)。 */
async function linkedOwnerNames(tx: Tx, propertyId: string): Promise<string[]> {
  const rows = await tx.propertyOwner.findMany({
    where: { propertyId },
    select: { owner: { select: { name: true } } },
  });
  return rows.map((r) => r.owner.name);
}

/** 結果の行を押さえる(無ければ「比べ直しが要る」で作ってから)。前の値を返す。 */
async function lockCheckRow(
  tx: Tx,
  propertyId: string,
): Promise<{ attachmentId: string | null; decision: string | null; result: string; stale: boolean }> {
  await tx.$executeRaw`
    INSERT INTO registry_owner_checks (property_id, result, stale)
    VALUES (${propertyId}::uuid, 'unreadable', true)
    ON CONFLICT (property_id) DO NOTHING
  `;
  const rows = await tx.$queryRaw<
    { attachment_id: string | null; decision: string | null; result: string; stale: boolean }[]
  >`
    SELECT attachment_id, decision, result, stale FROM registry_owner_checks
    WHERE property_id = ${propertyId}::uuid
    FOR UPDATE
  `;
  const r = rows[0];
  return { attachmentId: r.attachment_id, decision: r.decision, result: r.result, stale: r.stale };
}

/**
 * 結果を書く(ロックの中)。「このままでよい」は、同じ謄本で・まだ違うときだけ残す
 * (新しい謄本が付いた・名義が合った=判断は要らなくなった)。
 */
async function writeResult(
  tx: Tx,
  propertyId: string,
  attachmentId: string,
  result: RegistryOwnerCheckResult,
  prev: { attachmentId: string | null; decision: string | null },
  /** 違い(mismatch)のときの種類(記号と人数だけ)。それ以外は null。 */
  diff: { kind: string; rank: number } | null,
): Promise<void> {
  const keepDecision =
    prev.decision === "keep" && prev.attachmentId === attachmentId && result === "mismatch";
  await tx.registryOwnerCheck.update({
    where: { propertyId },
    data: {
      attachmentId,
      result,
      stale: false,
      checkedAt: new Date(),
      diffKind: diff?.kind ?? null,
      diffRank: diff?.rank ?? null,
      ...(keepDecision ? {} : { decision: null, decidedBy: null, decidedAt: null }),
    },
  });
}

/** 違い(mismatch)のときだけ、種類を求める(保存するのは記号と人数だけ)。 */
function diffOf(
  result: RegistryOwnerCheckResult,
  registryNames: readonly string[],
  systemNames: readonly string[],
): { kind: string; rank: number } | null {
  if (result !== "mismatch") return null;
  const d = ownerDiff(registryNames, systemNames);
  return { kind: d.stored, rank: d.rank };
}

/**
 * 1物件を比べて結果を残す。謄本(所有者事項)が無い物件は結果の行を消す。
 * 戻り値=残した結果(比べなかったら null)。
 */
export async function checkPropertyRegistryOwners(
  propertyId: string,
): Promise<RegistryOwnerCheckResult | null> {
  const read = await readRegistryNames(propertyId);
  if (read === "none") {
    // 所有者事項の謄本が無い(消された・全部事項だけ)=比べる対象ではない
    const latest = await findLatestOwnerRegistryAttachment(prisma, propertyId);
    if (!latest) await prisma.registryOwnerCheck.deleteMany({ where: { propertyId } });
    // 謄本はあるのに読む途中で入れ替わった・見つからなかった=比べ直し待ちにして試した時刻を残す
    // (種類の無い「違う」の行が、夜の自動の比べの先頭に居座り続けないように)
    else await markRetryAfterFailure(propertyId);
    return null;
  }
  return prisma.$transaction(async (tx) => {
    await lockPropertyRow(tx, propertyId);
    const prev = await lockCheckRow(tx, propertyId);
    // ⚠読んでから今までに別の謄本が付いた/消えたら書かない(比べ直しの印のまま残す)
    const latest = await findLatestOwnerRegistryAttachment(tx, propertyId);
    if (!latest || latest.id !== read.attachmentId) return null;
    const systemNames = read.names ? await linkedOwnerNames(tx, propertyId) : [];
    const result: RegistryOwnerCheckResult = read.names
      ? compareRegistryOwners(read.names, systemNames)
      : "unreadable";
    await writeResult(tx, propertyId, read.attachmentId, result, prev, diffOf(result, read.names ?? [], systemNames));
    return result;
  });
}

/** 夜の自動の比べで、失敗した(・つい1時間以内に試した)物件をもう一度試すまでの間。 */
export const REGISTRY_OWNER_CHECK_RETRY_AFTER_HOURS = 1;

/**
 * まだ比べていない・比べ直しが要る物件(アーカイブを除く・所有者事項の謄本あり)。
 * 「違う」で未判断なのに違いの種類がまだ無い行(種類を残す前に比べた行)も、比べ直しに数える
 * (比べ直すと種類が埋まる・その間も一覧には出たまま)。
 * backoff=true(夜の自動)のときは、比べ直し待ちのうち1時間以内に試した物件を後回しにする
 * (一時的な失敗の物件を2分ごとに読み続けない)。画面のボタンは後回しにしない(今すぐ試す)。
 * ⚠checked_at は UTC で入っている(Prisma)ので、比べる時刻も UTC にそろえる。
 */
function pendingWhereSql(limit: number | null, backoff = false) {
  const backoffHours = backoff ? REGISTRY_OWNER_CHECK_RETRY_AFTER_HOURS : 0;
  return limit === null
    ? prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*)::bigint AS n FROM properties p
        WHERE p.is_archived = false
          AND EXISTS (SELECT 1 FROM attachments a WHERE a.property_id = p.id AND a.type = 'registry'
                      AND a.is_deleted = false AND a.registry_certificate_type = ${SUPPORTED_CERTIFICATE_TYPE})
          AND NOT EXISTS (SELECT 1 FROM registry_owner_checks c WHERE c.property_id = p.id AND c.stale = false
                          AND NOT (c.result = 'mismatch' AND c.decision IS NULL AND c.diff_kind IS NULL))`
    : prisma.$queryRaw<{ id: string }[]>`
        SELECT p.id FROM properties p
        WHERE p.is_archived = false
          AND EXISTS (SELECT 1 FROM attachments a WHERE a.property_id = p.id AND a.type = 'registry'
                      AND a.is_deleted = false AND a.registry_certificate_type = ${SUPPORTED_CERTIFICATE_TYPE})
          AND NOT EXISTS (SELECT 1 FROM registry_owner_checks c WHERE c.property_id = p.id AND c.stale = false
                          AND NOT (c.result = 'mismatch' AND c.decision IS NULL AND c.diff_kind IS NULL))
          AND NOT EXISTS (SELECT 1 FROM registry_owner_checks c WHERE c.property_id = p.id AND c.stale = true
                          AND ${backoffHours}::int > 0
                          AND c.checked_at > (now() AT TIME ZONE 'UTC') - make_interval(hours => ${backoffHours}::int))
        ORDER BY p.id
        LIMIT ${limit}`;
}

export async function countPendingRegistryOwnerChecks(): Promise<number> {
  const rows = (await pendingWhereSql(null)) as { n: bigint }[];
  return Number(rows[0]?.n ?? 0);
}

/**
 * 比べられなかった(思わぬ失敗=保存場所の一時的な故障・ロック待ちの打ち切りなど)物件に、
 * 「試した時刻」だけを残す。**比べ直し待ちのまま**にして、あとでもう一度試す(@codex #679 R1 P2)。
 * ⚠「読めない」で確定させると、一時的な故障でも二度と比べられず、名義の警告が出なくなる。
 * ⚠前に比べた結果(違う など)と判断はそのまま残す(故障の間に警告が消えないように)。
 * 夜の自動の比べは、試した時刻から1時間は後回しにする(同じ物件を2分ごとに読み続けない)。
 */
async function markRetryAfterFailure(propertyId: string): Promise<void> {
  try {
    await prisma.$executeRaw`
      INSERT INTO registry_owner_checks (property_id, result, stale, checked_at)
      VALUES (${propertyId}::uuid, 'unreadable', true, (now() AT TIME ZONE 'UTC'))
      ON CONFLICT (property_id) DO UPDATE
        SET stale = true, checked_at = (now() AT TIME ZONE 'UTC')
    `;
  } catch {
    // 物件が消えた等。次の回で対象から外れる
  }
}

/**
 * まだ比べていない物件を最大 limit 件比べる。結果ごとの件数を返す(名前・物件は返さない)。
 * deadline を渡すと、その時刻を過ぎたら次の物件を始めない(夜の自動の比べで、2分ごとの
 * 呼び出しの持ち時間を越えないため)。
 */
export async function runRegistryOwnerChecks(
  limit: number,
  /** backoff=夜の自動(失敗して1時間以内の物件を後回し) */
  opts: { deadline?: number; backoff?: boolean } = {},
): Promise<{
  processed: number;
  counts: Record<string, number>;
  failed: number;
  remaining: number;
}> {
  const n = Math.max(1, Math.min(Math.floor(limit), REGISTRY_OWNER_CHECK_RUN_MAX));
  const targets = (await pendingWhereSql(n, opts.backoff ?? false)) as { id: string }[];
  const counts: Record<string, number> = {};
  let failed = 0;
  let processed = 0;
  for (const { id } of targets) {
    if (opts.deadline !== undefined && Date.now() >= opts.deadline) break;
    processed += 1;
    try {
      const r = await checkPropertyRegistryOwners(id);
      const k = r ?? "skipped";
      counts[k] = (counts[k] ?? 0) + 1;
    } catch (e) {
      failed += 1;
      // ⚠生のエラー文は出さない(謄本由来の文字を含みうる)
      const kind = e instanceof Error ? e.name : typeof e;
      console.error(`[registry-owner-check] 比べられませんでした kind=${kind}`);
      await markRetryAfterFailure(id);
    }
  }
  return { processed, counts, failed, remaining: await countPendingRegistryOwnerChecks() };
}

/**
 * 夜の自動の比べ(2026-11-08 発注者決定)。**新しい timer は置かず**、通知の送信で2分ごとに
 * 呼ばれている `/api/notifications/push-run` の最後に相乗りする。
 * - 日本時間の 2:00〜5:00 だけ動く(昼の画面を遅くしない)
 * - 1回(2分ごと)に最大 perTick 件・持ち時間 tickBudgetMs まで
 * - 1晩(その夜の 2:00 以降)に比べた件数が perNight に達したら、その夜はもう動かない
 *   (数え方は結果の行の checked_at=手で比べた分も含む)
 * 対象は画面のボタンと同じ「まだ比べていない・比べ直し待ち」。
 */
export const NIGHTLY_REGISTRY_OWNER_CHECK = {
  startHourJst: 2,
  endHourJst: 5,
  perTick: 20,
  perNight: 2000,
  tickBudgetMs: 30_000,
} as const;

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** その時刻が夜の枠の中なら、その夜の始まり(日本時間 2:00)を返す。枠の外なら null。 */
export function nightlyWindowStart(now: Date): Date | null {
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  const hour = jst.getUTCHours();
  if (hour < NIGHTLY_REGISTRY_OWNER_CHECK.startHourJst || hour >= NIGHTLY_REGISTRY_OWNER_CHECK.endHourJst) {
    return null;
  }
  const startJst = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate(), NIGHTLY_REGISTRY_OWNER_CHECK.startHourJst);
  return new Date(startJst - JST_OFFSET_MS);
}

export async function runNightlyRegistryOwnerChecks(
  now: Date,
  /** perTick / perNight はテストで小さくするためだけの差し替え口(既定=上の定数) */
  opts: { deadline?: number; perTick?: number; perNight?: number } = {},
): Promise<
  | { skipped: "outside_window" | "nightly_cap" | "no_time" }
  | { processed: number; counts: Record<string, number>; failed: number; remaining: number; doneTonight: number }
> {
  const windowStart = nightlyWindowStart(now);
  if (!windowStart) return { skipped: "outside_window" };
  const doneTonight = await prisma.registryOwnerCheck.count({ where: { checkedAt: { gte: windowStart } } });
  const quota = (opts.perNight ?? NIGHTLY_REGISTRY_OWNER_CHECK.perNight) - doneTonight;
  if (quota <= 0) return { skipped: "nightly_cap" };
  const deadline = Math.min(Date.now() + NIGHTLY_REGISTRY_OWNER_CHECK.tickBudgetMs, opts.deadline ?? Infinity);
  if (Date.now() >= deadline) return { skipped: "no_time" };
  const r = await runRegistryOwnerChecks(Math.min(opts.perTick ?? NIGHTLY_REGISTRY_OWNER_CHECK.perTick, quota), {
    deadline,
    backoff: true,
  });
  return { ...r, doneTonight: doneTonight + r.processed };
}

/** DM が「未判断」(hold)なら「送付可」(send)に戻す(ロックの中)。戻したら true。 */
export async function restoreDmSendIfHold(tx: Tx, propertyId: string, userId: string): Promise<boolean> {
  const updated = await tx.property.updateMany({
    where: { id: propertyId, dmStatus: "hold" },
    // ⚠版を上げる(開いている編集画面の古い値で黙って戻されないように=一括更新と同じ)
    data: { dmStatus: "send", version: { increment: 1 } },
  });
  if (updated.count === 0) return false;
  await tx.changeLog.create({
    data: {
      targetTable: "properties",
      targetId: propertyId,
      fieldName: "dmStatus",
      oldValue: "hold",
      newValue: "send",
      source: "manual",
      changedBy: userId,
    },
  });
  return true;
}

/** 置き換え(謄本の名義に直す)のあと、同じトランザクションで比べ直して結果を残す。 */
export async function recordCheckAfterReplace(
  tx: Tx,
  propertyId: string,
  attachmentId: string,
  registryNames: string[],
): Promise<RegistryOwnerCheckResult> {
  const prev = await lockCheckRow(tx, propertyId);
  const systemNames = await linkedOwnerNames(tx, propertyId);
  const result = compareRegistryOwners(registryNames, systemNames);
  await writeResult(tx, propertyId, attachmentId, result, prev, diffOf(result, registryNames, systemNames));
  return result;
}

export const checkChangedError = () =>
  new ApiError(
    409,
    "この物件はあとから所有者か謄本が変わりました。開き直してください",
    "REGISTRY_OWNER_CHECK_CHANGED",
  );

/** 「このままでよい」。判断した人と日時を残す。restoreDm なら DM を送付可に戻す。 */
export async function keepRegistryOwners(args: {
  session: { id: string; role: string };
  propertyId: string;
  expectedAttachmentId: string;
  restoreDm: boolean;
}): Promise<{ dmRestored: boolean }> {
  const { session, propertyId } = args;
  return prisma.$transaction(async (tx) => {
    await lockPropertyRecordForWrite(tx, propertyId, session);
    const rows = await tx.$queryRaw<
      { attachment_id: string | null; decision: string | null; result: string; stale: boolean }[]
    >`
      SELECT attachment_id, decision, result, stale FROM registry_owner_checks
      WHERE property_id = ${propertyId}::uuid
      FOR UPDATE
    `;
    const row = rows[0];
    if (
      !row ||
      row.stale ||
      row.result !== "mismatch" ||
      row.decision !== null ||
      row.attachment_id !== args.expectedAttachmentId
    ) {
      throw checkChangedError();
    }
    await tx.registryOwnerCheck.update({
      where: { propertyId },
      data: { decision: "keep", decidedBy: session.id, decidedAt: new Date() },
    });
    const dmRestored = args.restoreDm ? await restoreDmSendIfHold(tx, propertyId, session.id) : false;
    return { dmRestored };
  });
}
