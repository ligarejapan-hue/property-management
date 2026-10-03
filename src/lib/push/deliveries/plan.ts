/**
 * 通知 段階4b: 送信の記録を作る(どの端末にどの件を送るか・設計書 §7.3・§7.4)。送るのは `send.ts`。
 *
 * - 次回対応: 端末の行を `FOR UPDATE SKIP LOCKED` で押さえ、その端末(結び付け)にまだ含めていない件を
 *   まとめて1通にする。押さえられなかった端末はその回は飛ばす(次の実行で作る)。
 * - 査定申込・謄本ジョブ: サーバー側のカーソルの行を押さえ、カーソルより後と読み直し(5分前から)を読む。
 *   **初めて見つけた出来事だけ**その時点で結び付いている端末に送信記録を作り、同じトランザクションで
 *   カーソルを進める(途中で失敗したらカーソルも巻き戻る=次の実行でやり直す)。
 * - ref_key に中身(物件名など)は入れない。
 */
import prisma from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma";
import { advanceCursor, afterCursorWhere, pageAfterWhere, REREAD_PAGE, AFTER_CURSOR_LIMIT, rereadWhere } from "@/lib/notifications/event-cursor";
import type { EventCursor } from "@/lib/notifications/opaque";
import {
  canReceiveInquiryNotice,
  canReceiveRegistryNotice,
  dueNextActions,
  inquiryInScope,
  loadRecipient,
  type DueNextAction,
  type Recipient,
} from "./eligibility";
import {
  eventRefKey,
  kindOfSource,
  nextActionRefKey,
  SEND_TX_MAX_WAIT_MS,
  SEND_TX_TIMEOUT_MS,
  SOURCE_EVENTS_PER_TX,
  SOURCE_PLAN_TX_TIMEOUT_MS,
  type Source,
} from "./rules";

type Tx = Prisma.TransactionClient;
const TX_OPTS = { timeout: SEND_TX_TIMEOUT_MS, maxWait: SEND_TX_MAX_WAIT_MS };

/** 送ってよい端末(無効化・期限切れでない・利用者が在籍)。 */
function activeSubscriptionWhere(now: Date) {
  return { revokedAt: null, expiresAt: { gt: now }, user: { isActive: true } };
}

/** 端末の行を押さえる。ほかの処理(送信・付け替え)が押さえていれば待たずに null。 */
export async function lockSubscription(tx: Tx, id: string) {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "push_subscriptions" WHERE "id" = ${id}::uuid FOR UPDATE SKIP LOCKED`;
  if (locked.length === 0) return null;
  return tx.pushSubscription.findUnique({ where: { id } });
}

/** その端末(結び付け)にまだ含めていない ref_key だけを1通にまとめて記録する。作った通数(0か1)を返す。 */
async function createDelivery(
  tx: Tx,
  sub: { id: string; userId: string; bindingId: string },
  kind: "next_action" | "inquiry_new" | "registry_job_done",
  refKeys: string[],
  now: Date,
): Promise<number> {
  if (refKeys.length === 0) return 0;
  const existing = await tx.notificationDeliveryRef.findMany({
    where: { bindingId: sub.bindingId, kind, refKey: { in: refKeys } },
    select: { refKey: true },
  });
  const seen = new Set(existing.map((e) => e.refKey));
  const fresh = [...new Set(refKeys)].filter((k) => !seen.has(k));
  if (fresh.length === 0) return 0;
  const d = await tx.notificationDelivery.create({
    data: { userId: sub.userId, subscriptionId: sub.id, bindingId: sub.bindingId, kind, scheduledFor: now },
    select: { id: true },
  });
  const r = await tx.notificationDeliveryRef.createMany({
    data: fresh.map((refKey) => ({ deliveryId: d.id, subscriptionId: sub.id, bindingId: sub.bindingId, kind, refKey })),
    skipDuplicates: true,
  });
  if (r.count === 0) {
    await tx.notificationDelivery.delete({ where: { id: d.id } });
    return 0;
  }
  return 1;
}

// ---------- 次回対応(N4・N5) ----------

export async function planNextActionDeliveries(now: Date, opts: { deadlineMs?: number } = {}): Promise<number> {
  const pastDeadline = () => opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs;
  const subs = await prisma.pushSubscription.findMany({
    where: activeSubscriptionWhere(now),
    select: { id: true, userId: true },
    orderBy: { id: "asc" },
  });
  const byUser = new Map<string, string[]>();
  for (const s of subs) byUser.set(s.userId, [...(byUser.get(s.userId) ?? []), s.id]);
  let created = 0;
  for (const [userId, subIds] of byUser) {
    // 持ち時間を過ぎたら新しく始めない(残りは次の実行で。回は今の1回だけなので取りこぼしにはならない)。
    if (pastDeadline()) break;
    const r = await loadRecipient(prisma, userId);
    if (!r) continue;
    const due = await dueNextActions(prisma, r, now);
    if (due.length === 0) continue;
    for (const subId of subIds) {
      if (pastDeadline()) break;
      created += await prisma.$transaction(async (tx) => {
        const s = await lockSubscription(tx, subId);
        if (!s || s.userId !== userId || s.revokedAt || s.expiresAt <= now) return 0;
        return createDelivery(tx, s, "next_action", nextActionKeysFor(due, s.boundAt), now);
      }, TX_OPTS);
    }
  }
  return created;
}

/** 端末が今の利用者に結び付く前の回は送らない(§7.3)。 */
export function nextActionKeysFor(due: DueNextAction[], boundAt: Date): string[] {
  return due.filter((d) => d.slotTime >= boundAt.getTime()).map((d) => nextActionRefKey(d.id, d.deadline, d.revMs, d.slot));
}

// ---------- 査定申込(N6)・謄本ジョブ(N7) ----------

type EventRow = { id: string; t: Date };

function fetcher(tx: Tx, source: Source) {
  if (source === "inquiry") {
    return async (where: object, take: number): Promise<EventRow[]> => {
      const rows = await tx.dmInquiry.findMany({
        where: where as Prisma.DmInquiryWhereInput,
        orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
        take,
        select: { id: true, submittedAt: true },
      });
      return rows.map((r) => ({ id: r.id, t: r.submittedAt }));
    };
  }
  return async (where: object, take: number): Promise<EventRow[]> => {
    const rows = await tx.registryFetchJob.findMany({
      where: { AND: [where as Prisma.RegistryFetchJobWhereInput, { status: "completed", completedAt: { not: null } }] },
      orderBy: [{ completedAt: "asc" }, { id: "asc" }],
      take,
      select: { id: true, completedAt: true },
    });
    return rows.filter((r) => r.completedAt !== null).map((r) => ({ id: r.id, t: r.completedAt as Date }));
  };
}

const FIELD: Record<Source, "submittedAt" | "completedAt"> = { inquiry: "submittedAt", registry_job: "completedAt" };

/** 読み直し(5分前〜カーソル)を100件ずつめくって全件読む(件数で打ち切らない・§5.1)。 */
async function readAll(fetchPage: (where: object, take: number) => Promise<EventRow[]>, field: "submittedAt" | "completedAt", where: object) {
  const out: EventRow[] = [];
  let last: EventCursor | null = null;
  for (;;) {
    const page = await fetchPage({ AND: [where, pageAfterWhere(field, last)] }, REREAD_PAGE);
    out.push(...page);
    if (page.length < REREAD_PAGE) return out;
    const tail = page[page.length - 1];
    last = { t: tail.t, i: tail.id };
  }
}

/** 送信記録の表が無い(migration 前)ときに投げる。 */
export class MissingSourceCursorError extends Error {
  constructor() {
    super("notification_source_cursor_missing");
  }
}

/**
 * 1回分(1トランザクション)の記録づくり。新しく見つけた出来事は `SOURCE_EVENTS_PER_TX` 件までにし、
 * 残りがあれば `more: true`(呼び出し側が続けて呼ぶ)。
 * 処理する順は「読み直し範囲(カーソルより前=古い)→ カーソルより後」。カーソルは、処理し終えた
 * 「カーソルより後」の行までしか進めない(途中で打ち切っても、まだの出来事が読み直し範囲から外れない)。
 */
/**
 * 申込・謄本ジョブの送り先になれる人(在籍・権限・通知 ON)。権限の確かめは時間がかかりうるので、
 * **カーソルを押さえるトランザクションの外で**1回の実行に1度だけ求める(@codex #472 P2)。
 * 送る直前にも確かめ直すので、この間に権限が外れた人には送らない。
 */
export interface SourceRecipients {
  inquiry: Recipient[];
  registry: Map<string, Recipient>;
}

/**
 * `deadlineMs` を過ぎたら途中でやめて null を返す(呼び出し側はその回の記録づくりをしない=
 * 一部の人だけで出来事を「見つけ済み」にしない)。
 */
export async function loadSourceRecipients(deadlineMs?: number): Promise<SourceRecipients | null> {
  const users = await prisma.user.findMany({ where: { isActive: true }, select: { id: true }, orderBy: { id: "asc" } });
  const inquiry: Recipient[] = [];
  const registry = new Map<string, Recipient>();
  for (const u of users) {
    if (deadlineMs !== undefined && Date.now() >= deadlineMs) return null;
    const r = await loadRecipient(prisma, u.id);
    if (!r) continue;
    if (await canReceiveInquiryNotice(r)) inquiry.push(r);
    if (canReceiveRegistryNotice(r)) registry.set(r.id, r);
  }
  return { inquiry, registry };
}

export async function planSourceDeliveries(
  source: Source,
  now: Date,
  recipients?: SourceRecipients,
): Promise<{ created: number; more: boolean }> {
  const who = recipients ?? (await loadSourceRecipients());
  if (!who) return { created: 0, more: true };
  return prisma.$transaction(async (tx) => {
    // カーソルの行を押さえる(同時に2つの実行が同じ出来事を数えない)。
    const locked = await tx.$queryRaw<Array<{ source: string }>>`
      SELECT "source" FROM "notification_source_cursors" WHERE "source" = ${source} FOR UPDATE`;
    if (locked.length === 0) throw new MissingSourceCursorError();
    const row = await tx.notificationSourceCursor.findUnique({ where: { source } });
    if (!row) throw new MissingSourceCursorError();
    const c: EventCursor = { t: row.cursorT, i: row.cursorId };
    // 見つけた時刻=カーソルを押さえて読んだ今(実行の始めの時刻ではない)。この時点で結び付いている
    // 端末に送る(実行の途中で結び付いた端末を、見つけ済みにしたまま取りこぼさない・@codex #472 P2)。
    const seenAt = new Date(Math.max(now.getTime(), Date.now()));
    const field = FIELD[source];
    const fetchPage = fetcher(tx, source);
    const after = await fetchPage(afterCursorWhere(field, c), AFTER_CURSOR_LIMIT);
    const reread = await readAll(fetchPage, field, rereadWhere(field, c));
    // 読み直し範囲(古い)を先に、カーソルより後をあとに(どちらも時刻と ID の昇順)。
    const ordered: EventRow[] = [];
    const seenIds = new Set<string>();
    for (const r of [...reread, ...after]) {
      if (seenIds.has(r.id)) continue;
      seenIds.add(r.id);
      ordered.push(r);
    }
    // 初めて見つけた出来事だけ(すでに見つけた出来事は、あとから結び付いた端末へ送らない・§7.3)。
    const known = ordered.length
      ? await tx.notificationSourceEvent.findMany({ where: { source, eventId: { in: ordered.map((r) => r.id) } }, select: { eventId: true } })
      : [];
    const knownSet = new Set(known.map((k) => k.eventId));
    const freshRows = ordered.filter((r) => !knownSet.has(r.id));
    const take = freshRows.slice(0, SOURCE_EVENTS_PER_TX);
    const more = freshRows.length > take.length;

    let created = 0;
    if (take.length > 0) {
      const fresh = take.map((r) => r.id);
      await tx.notificationSourceEvent.createMany({
        data: fresh.map((eventId) => ({ source, eventId, firstSeenAt: seenAt })),
        skipDuplicates: true,
      });
      created =
        source === "inquiry" ? await planInquiries(tx, fresh, seenAt, who.inquiry) : await planRegistryJobs(tx, fresh, seenAt, who.registry);
    }
    // カーソルは「カーソルより後」のうち、まだ処理していない新しい出来事の手前までだけ進める。
    const firstPending = more ? freshRows[take.length] : null;
    const pendingIdx = firstPending ? after.findIndex((r) => r.id === firstPending.id) : -1;
    const done = firstPending ? (pendingIdx < 0 ? [] : after.slice(0, pendingIdx)) : after;
    const next = advanceCursor(c, done.map((r) => ({ t: r.t, i: r.id })));
    await tx.notificationSourceCursor.update({ where: { source }, data: { cursorT: next.t, cursorId: next.i, updatedAt: now } });
    // カーソルより後が上限まで埋まっていたら、その先にもまだある(続けて読む)。
    return { created, more: more || after.length >= AFTER_CURSOR_LIMIT };
  }, { timeout: SOURCE_PLAN_TX_TIMEOUT_MS, maxWait: SEND_TX_MAX_WAIT_MS });
}

/** 今の時点で結び付いている端末(結び付けが今以前)。 */
async function boundSubscriptions(tx: Tx, userIds: string[], now: Date) {
  if (userIds.length === 0) return [];
  return tx.pushSubscription.findMany({
    where: { ...activeSubscriptionWhere(now), userId: { in: userIds }, boundAt: { lte: now } },
    select: { id: true, userId: true, bindingId: true },
    orderBy: { id: "asc" },
  });
}

async function planInquiries(tx: Tx, inquiryIds: string[], now: Date, recipients: Recipient[]): Promise<number> {
  const inquiries = await tx.dmInquiry.findMany({
    where: { id: { in: inquiryIds } },
    select: { id: true, draft: { select: { property: { select: { createdBy: true, assignedTo: true } } } } },
  });
  const subs = await boundSubscriptions(tx, recipients.map((r) => r.id), now);
  let created = 0;
  for (const s of subs) {
    const r = recipients.find((x) => x.id === s.userId);
    if (!r) continue;
    const keys = inquiries.filter((q) => inquiryInScope(r, q.draft?.property ?? null)).map((q) => eventRefKey("inquiry", q.id));
    created += await createDelivery(tx, s, kindOfSource("inquiry"), keys, now);
  }
  return created;
}

async function planRegistryJobs(tx: Tx, jobIds: string[], now: Date, recipients: Map<string, Recipient>): Promise<number> {
  const jobs = await tx.registryFetchJob.findMany({ where: { id: { in: jobIds } }, select: { id: true, requestedById: true } });
  let created = 0;
  for (const job of jobs) {
    if (!job.requestedById) continue;
    const r = recipients.get(job.requestedById);
    if (!r) continue;
    // 件数(今見られる物件だけで数え直す)は送る直前に確かめる。ジョブごとに1通。
    for (const s of await boundSubscriptions(tx, [r.id], now)) {
      created += await createDelivery(tx, s, kindOfSource("registry_job"), [eventRefKey("registry_job", job.id)], now);
    }
  }
  return created;
}
