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
import { randomInt, randomUUID } from "crypto";
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
  SOURCE_PLAN_TX_TIMEOUT_MS,
  rotateStart,
  sourceEventsPerTx,
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

type SubRef = { id: string; userId: string; bindingId: string };
const BULK_CHUNK = 1000;
const NEXT_ACTION_SCAN_LIMIT = 5000;

/**
 * 端末(結び付け)ごとに、まだ含めていない ref_key だけを1通にまとめて記録する。作った通数を返す。
 * 端末の数によらず問い合わせの回数が一定になるよう、まとめて読み・まとめて書く(@codex #472 P2)。
 */
async function createDeliveries(
  tx: Tx,
  items: Array<{ sub: SubRef; refKeys: string[] }>,
  kind: "next_action" | "inquiry_new" | "registry_job_done",
  now: Date,
): Promise<number> {
  const wanted = items.filter((x) => x.refKeys.length > 0);
  if (wanted.length === 0) return 0;
  const allKeys = [...new Set(wanted.flatMap((x) => x.refKeys))];
  const bindings = [...new Set(wanted.map((x) => x.sub.bindingId))];
  const existing = new Set<string>();
  for (let i = 0; i < bindings.length; i += BULK_CHUNK) {
    const rows = await tx.notificationDeliveryRef.findMany({
      where: { kind, bindingId: { in: bindings.slice(i, i + BULK_CHUNK) }, refKey: { in: allKeys } },
      select: { bindingId: true, refKey: true },
    });
    for (const r of rows) existing.add(`${r.bindingId}|${r.refKey}`);
  }
  // 査定申込は、その端末のまだ送っていない1通(pending)があれば、そこへ足す(溜まった申込を何回かに分けて
  // 記録しても、端末ごとに1通にまとめる・@codex #472 P2)。行を押さえて足すので、送信の取り合いはこの
  // トランザクションが終わるまで待つ(足した件も一緒に送られる)。送信中・押さえられない行には足さない。
  const reuse = new Map<string, string>();
  if (kind === "inquiry_new") {
    const subIds = [...new Set(wanted.map((x) => x.sub.id))];
    for (let i = 0; i < subIds.length; i += BULK_CHUNK) {
      const rows = await tx.$queryRaw<Array<{ id: string; subscription_id: string; binding_id: string }>>`
        SELECT "id", "subscription_id", "binding_id" FROM "notification_deliveries"
        WHERE "kind" = 'inquiry_new' AND "status" = 'pending' AND "subscription_id" = ANY(${subIds.slice(i, i + BULK_CHUNK)}::uuid[])
        FOR UPDATE SKIP LOCKED`;
      for (const r of rows) reuse.set(`${r.subscription_id}|${r.binding_id}`, r.id);
    }
  }
  const deliveries: Array<{ id: string; userId: string; subscriptionId: string; bindingId: string; kind: string; scheduledFor: Date }> = [];
  const refs: Array<{ deliveryId: string; subscriptionId: string; bindingId: string; kind: string; refKey: string }> = [];
  for (const { sub, refKeys } of wanted) {
    const fresh = [...new Set(refKeys)].filter((k) => !existing.has(`${sub.bindingId}|${k}`));
    if (fresh.length === 0) continue;
    let id = reuse.get(`${sub.id}|${sub.bindingId}`);
    if (!id) {
      id = randomUUID();
      deliveries.push({ id, userId: sub.userId, subscriptionId: sub.id, bindingId: sub.bindingId, kind, scheduledFor: now });
    }
    for (const refKey of fresh) refs.push({ deliveryId: id, subscriptionId: sub.id, bindingId: sub.bindingId, kind, refKey });
  }
  for (let i = 0; i < deliveries.length; i += BULK_CHUNK) {
    await tx.notificationDelivery.createMany({ data: deliveries.slice(i, i + BULK_CHUNK) });
  }
  // 足した先の1通は、送り直しの期間の起点を今に更新する(古い1通に足した新しい件が、送り直しの
  // 期間切れで二度と送られなくなる、を防ぐ・@codex #472 P2)。
  const reusedIds = [...new Set(refs.map((r) => r.deliveryId))].filter((id) => !deliveries.some((d) => d.id === id));
  if (reusedIds.length) {
    await tx.notificationDelivery.updateMany({ where: { id: { in: reusedIds }, status: "pending" }, data: { scheduledFor: now } });
  }
  for (let i = 0; i < refs.length; i += BULK_CHUNK) {
    await tx.notificationDeliveryRef.createMany({ data: refs.slice(i, i + BULK_CHUNK), skipDuplicates: true });
  }
  return deliveries.length;
}

/** 1つの端末の分(次回対応)。 */
function createDelivery(tx: Tx, sub: SubRef, kind: "next_action" | "inquiry_new" | "registry_job_done", refKeys: string[], now: Date): Promise<number> {
  return createDeliveries(tx, [{ sub, refKeys }], kind, now);
}

// ---------- 次回対応(N4・N5) ----------

export async function planNextActionDeliveries(now: Date, opts: { deadlineMs?: number } = {}): Promise<number> {
  // 1つのトランザクションは最大 SEND_TX_TIMEOUT_MS かかるので、その分を残して打ち切る(締め切りを
  // 越えて送信の時間を食わない・@codex #472 P2)。
  const pastDeadline = () => opts.deadlineMs !== undefined && Date.now() + SEND_TX_TIMEOUT_MS >= opts.deadlineMs;
  if (pastDeadline()) return 0;
  // 1回に見る端末は5,000台まで。多いときは始める位置を乱数でずらし、毎回同じ所だけを見ない(@codex #472 P2)。
  const total = await prisma.pushSubscription.count({ where: activeSubscriptionWhere(now) });
  const skip = total > NEXT_ACTION_SCAN_LIMIT ? randomInt(total - NEXT_ACTION_SCAN_LIMIT + 1) : 0;
  const subs = await prisma.pushSubscription.findMany({
    where: activeSubscriptionWhere(now),
    select: { id: true, userId: true },
    orderBy: { id: "asc" },
    skip,
    take: NEXT_ACTION_SCAN_LIMIT,
  });
  const byUser = new Map<string, string[]>();
  for (const s of subs) byUser.set(s.userId, [...(byUser.get(s.userId) ?? []), s.id]);
  let created = 0;
  // 始める利用者は実行ごとにずらす(持ち時間で打ち切っても、毎回同じ後ろの人が漏れ続けない・@codex #472 P2)。
  const entries = [...byUser.entries()];
  for (const [userId, subIds] of rotateStart(entries, entries.length ? randomInt(entries.length) : 0)) {
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
 * 1回分(1トランザクション)の記録づくり。新しく見つけた出来事は `sourceEventsPerTx`(送り先の端末の数で1〜100件)までにし、
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
  // 送ってよい端末を持つ人だけを見る(端末の無い人は送り先にならない=全員を確かめない・@codex #472 P2)。
  const users = await prisma.user.findMany({
    where: { isActive: true, pushSubscriptions: { some: { revokedAt: null, expiresAt: { gt: new Date() } } } },
    select: { id: true },
    orderBy: { id: "asc" },
  });
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
  // 送り先の端末の数(トランザクションの外で数える)に合わせて、1回分で扱う出来事の件数を決める。
  const recipientIds = source === "inquiry" ? who.inquiry.map((r) => r.id) : [...who.registry.keys()];
  const subscriptionCount = recipientIds.length
    ? await prisma.pushSubscription.count({ where: { ...activeSubscriptionWhere(now), userId: { in: recipientIds } } })
    : 0;
  const perTx = sourceEventsPerTx(subscriptionCount);
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
    const take = freshRows.slice(0, perTx);
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
  const byId = new Map(recipients.map((r) => [r.id, r]));
  const items: Array<{ sub: SubRef; refKeys: string[] }> = [];
  for (const s of subs) {
    const r = byId.get(s.userId);
    if (!r) continue;
    items.push({ sub: s, refKeys: inquiries.filter((q) => inquiryInScope(r, q.draft?.property ?? null)).map((q) => eventRefKey("inquiry", q.id)) });
  }
  return createDeliveries(tx, items, kindOfSource("inquiry"), now);
}

async function planRegistryJobs(tx: Tx, jobIds: string[], now: Date, recipients: Map<string, Recipient>): Promise<number> {
  const jobs = await tx.registryFetchJob.findMany({ where: { id: { in: jobIds } }, select: { id: true, requestedById: true } });
  const owners = [...new Set(jobs.flatMap((j) => (j.requestedById && recipients.has(j.requestedById) ? [j.requestedById] : [])))];
  const subs = await boundSubscriptions(tx, owners, now);
  // 件数(今見られる物件だけで数え直す)は送る直前に確かめる。ジョブごと・端末ごとに1通。
  const items: Array<{ sub: SubRef; refKeys: string[] }> = [];
  for (const job of jobs) {
    if (!job.requestedById || !recipients.has(job.requestedById)) continue;
    for (const s of subs) if (s.userId === job.requestedById) items.push({ sub: s, refKeys: [eventRefKey("registry_job", job.id)] });
  }
  return createDeliveries(tx, items, kindOfSource("registry_job"), now);
}
