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

type Tx = ReplaceTx;

/** 1回の「比べる」で扱う上限(謄本を読むので重い)。 */
export const REGISTRY_OWNER_CHECK_RUN_MAX = 50;

/** 謄本の名義を読む。読めなければ null。謄本が無ければ "none"。 */
async function readRegistryNames(
  propertyId: string,
): Promise<{ attachmentId: string; names: string[] | null } | "none"> {
  const latest = await findLatestOwnerRegistryAttachment(prisma, propertyId);
  if (!latest) return "none";
  try {
    const registry = await loadLatestRegistryText(propertyId, latest.id);
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
      ...(keepDecision ? {} : { decision: null, decidedBy: null, decidedAt: null }),
    },
  });
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
    return null;
  }
  return prisma.$transaction(async (tx) => {
    await lockPropertyRow(tx, propertyId);
    const prev = await lockCheckRow(tx, propertyId);
    // ⚠読んでから今までに別の謄本が付いた/消えたら書かない(比べ直しの印のまま残す)
    const latest = await findLatestOwnerRegistryAttachment(tx, propertyId);
    if (!latest || latest.id !== read.attachmentId) return null;
    const result: RegistryOwnerCheckResult = read.names
      ? compareRegistryOwners(read.names, await linkedOwnerNames(tx, propertyId))
      : "unreadable";
    await writeResult(tx, propertyId, read.attachmentId, result, prev);
    return result;
  });
}

/** まだ比べていない・比べ直しが要る物件(アーカイブを除く・所有者事項の謄本あり)。 */
function pendingWhereSql(limit: number | null) {
  return limit === null
    ? prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*)::bigint AS n FROM properties p
        WHERE p.is_archived = false
          AND EXISTS (SELECT 1 FROM attachments a WHERE a.property_id = p.id AND a.type = 'registry'
                      AND a.is_deleted = false AND a.registry_certificate_type = ${SUPPORTED_CERTIFICATE_TYPE})
          AND NOT EXISTS (SELECT 1 FROM registry_owner_checks c WHERE c.property_id = p.id AND c.stale = false)`
    : prisma.$queryRaw<{ id: string }[]>`
        SELECT p.id FROM properties p
        WHERE p.is_archived = false
          AND EXISTS (SELECT 1 FROM attachments a WHERE a.property_id = p.id AND a.type = 'registry'
                      AND a.is_deleted = false AND a.registry_certificate_type = ${SUPPORTED_CERTIFICATE_TYPE})
          AND NOT EXISTS (SELECT 1 FROM registry_owner_checks c WHERE c.property_id = p.id AND c.stale = false)
        ORDER BY p.id
        LIMIT ${limit}`;
}

export async function countPendingRegistryOwnerChecks(): Promise<number> {
  const rows = (await pendingWhereSql(null)) as { n: bigint }[];
  return Number(rows[0]?.n ?? 0);
}

/** まだ比べていない物件を最大 limit 件比べる。結果ごとの件数を返す(名前・物件は返さない)。 */
export async function runRegistryOwnerChecks(limit: number): Promise<{
  processed: number;
  counts: Record<string, number>;
  failed: number;
  remaining: number;
}> {
  const n = Math.max(1, Math.min(Math.floor(limit), REGISTRY_OWNER_CHECK_RUN_MAX));
  const targets = (await pendingWhereSql(n)) as { id: string }[];
  const counts: Record<string, number> = {};
  let failed = 0;
  for (const { id } of targets) {
    try {
      const r = await checkPropertyRegistryOwners(id);
      const k = r ?? "skipped";
      counts[k] = (counts[k] ?? 0) + 1;
    } catch (e) {
      failed += 1;
      // ⚠生のエラー文は出さない(謄本由来の文字を含みうる)
      const kind = e instanceof Error ? e.name : typeof e;
      console.error(`[registry-owner-check] 比べられませんでした kind=${kind}`);
    }
  }
  return { processed: targets.length, counts, failed, remaining: await countPendingRegistryOwnerChecks() };
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
  const result = compareRegistryOwners(registryNames, await linkedOwnerNames(tx, propertyId));
  await writeResult(tx, propertyId, attachmentId, result, prev);
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
