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
  EDIT_LOCK_LOSS_NOTIFY_WINDOW_MS,
  editLockLossRefKey,
  eventRefKey,
  kindOfSource,
  nextActionRefKey,
  SEND_TX_MAX_WAIT_MS,
  SEND_TX_TIMEOUT_MS,
  SOURCE_PLAN_TX_TIMEOUT_MS,
  SOURCE_REFS_PER_TX,
  DELIVERY_REFS_MAX,
  rotateStart,
  sourceEventsPerTx,
  type DeliveryKind,
  type Source,
} from "./rules";
import { recordExpiredEditLockLosses } from "@/lib/edit-lock/service";

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
  kind: DeliveryKind,
  now: Date,
  maxRefs = Number.POSITIVE_INFINITY,
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
  //   ⚠1通に含める件は DELIVERY_REFS_MAX まで(それを超える1通には足さず、新しい1通にする・@codex #472 P2)。
  const reuse = new Map<string, { id: string; n: number }>();
  if (kind === "inquiry_new") {
    const subIds = [...new Set(wanted.map((x) => x.sub.id))];
    for (let i = 0; i < subIds.length; i += BULK_CHUNK) {
      const rows = await tx.$queryRaw<Array<{ id: string; subscription_id: string; binding_id: string; n: number }>>`
        SELECT d."id", d."subscription_id", d."binding_id",
               (SELECT count(*)::int FROM "notification_delivery_refs" r WHERE r."delivery_id" = d."id") AS n
        FROM "notification_deliveries" d
        WHERE d."kind" = 'inquiry_new' AND d."status" = 'pending' AND d."subscription_id" = ANY(${subIds.slice(i, i + BULK_CHUNK)}::uuid[])
        FOR UPDATE OF d SKIP LOCKED`;
      for (const r of rows) {
        const k = `${r.subscription_id}|${r.binding_id}`;
        const cur = reuse.get(k);
        if (r.n < DELIVERY_REFS_MAX && (!cur || r.n < cur.n)) reuse.set(k, { id: r.id, n: r.n });
      }
    }
  }
  const deliveries: Array<{ id: string; userId: string; subscriptionId: string; bindingId: string; kind: string; scheduledFor: Date }> = [];
  const refs: Array<{ deliveryId: string; subscriptionId: string; bindingId: string; kind: string; refKey: string }> = [];
  const filling = new Map<string, { id: string; n: number }>();
  for (const { sub, refKeys } of wanted) {
    if (refs.length >= maxRefs) break;
    const fresh = [...new Set(refKeys)].filter((k) => !existing.has(`${sub.bindingId}|${k}`)).slice(0, maxRefs - refs.length);
    if (fresh.length === 0) continue;
    // 同じ端末の件を1通へまとめるのは申込だけ(謄本ジョブ・編集権限は1件=1通・次回対応は端末ごとに1回で渡される)。
    const slot = `${sub.id}|${sub.bindingId}`;
    let cur = kind === "inquiry_new" ? (filling.get(slot) ?? reuse.get(slot)) : undefined;
    for (const refKey of fresh) {
      if (!cur || cur.n >= DELIVERY_REFS_MAX) {
        cur = { id: randomUUID(), n: 0 };
        deliveries.push({ id: cur.id, userId: sub.userId, subscriptionId: sub.id, bindingId: sub.bindingId, kind, scheduledFor: now });
      }
      refs.push({ deliveryId: cur.id, subscriptionId: sub.id, bindingId: sub.bindingId, kind, refKey });
      cur.n += 1;
    }
    filling.set(slot, cur as { id: string; n: number });
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
function createDelivery(tx: Tx, sub: SubRef, kind: DeliveryKind, refKeys: string[], now: Date, maxRefs?: number): Promise<number> {
  return createDeliveries(tx, [{ sub, refKeys }], kind, now, maxRefs);
}

// ---------- 次回対応(N4・N5) ----------

export async function planNextActionDeliveries(now: Date, opts: { deadlineMs?: number } = {}): Promise<number> {
  // 1つのトランザクションは最大 SEND_TX_TIMEOUT_MS かかるので、その分を残して打ち切る(締め切りを
  // 越えて送信の時間を食わない・@codex #472 P2)。
  const pastDeadline = () => opts.deadlineMs !== undefined && Date.now() + SEND_TX_TIMEOUT_MS >= opts.deadlineMs;
  if (pastDeadline()) return 0;
  // 1回に見る端末は5,000台まで。多いときは始める位置を乱数でずらし、毎回同じ所だけを見ない(@codex #472 P2)。
  //   窓は輪にする(終わりまで来たら先頭から続ける=端の端末も同じ確率で選ばれる・@codex #472 P2)。
  const total = await prisma.pushSubscription.count({ where: activeSubscriptionWhere(now) });
  const page = (skip: number, take: number) =>
    prisma.pushSubscription.findMany({
      where: activeSubscriptionWhere(now),
      select: { id: true, userId: true },
      orderBy: { id: "asc" },
      skip,
      take,
    });
  let subs: Array<{ id: string; userId: string }>;
  if (total <= NEXT_ACTION_SCAN_LIMIT) {
    subs = await page(0, NEXT_ACTION_SCAN_LIMIT);
  } else {
    const start = randomInt(total);
    const head = await page(start, NEXT_ACTION_SCAN_LIMIT);
    subs = head.length < NEXT_ACTION_SCAN_LIMIT ? [...head, ...(await page(0, NEXT_ACTION_SCAN_LIMIT - head.length))] : head;
  }
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
        // 1回で新しく作るのは2,000件まで(作り済みを除いて古い予定から・残りは次の実行で・@codex #472 P2)。
        return createDelivery(tx, s, "next_action", nextActionKeysFor(due, s.boundAt), now, SOURCE_REFS_PER_TX);
      }, TX_OPTS);
    }
  }
  return created;
}

/** 端末が今の利用者に結び付く前の回は送らない(§7.3)。 */
export function nextActionKeysFor(due: DueNextAction[], boundAt: Date): string[] {
  return due.filter((d) => d.slotTime >= boundAt.getTime()).map((d) => nextActionRefKey(d.id, d.deadline, d.revMs, d.slot));
}

// ---------- 編集権限が外れた(N2・段階4c) ----------

/**
 * 外れた記録を端末ごとの送信記録に分けてから締める(設計書 §7.2・§7.3)。
 * - 取り直されないまま期限が過ぎた鍵を先に記録する(取り直し・管理者の解除は、その場で記録済み)。
 * - 1時間を過ぎた記録は送らずに締める(expired)。
 * - 外れた時刻より後に結び付いた端末には送らない(端末を持っていない間の古い記録を送らない)。
 * - 送ってよい端末が無くても締める(queued)。記録は SKIP LOCKED で押さえる=同時に2つの実行が同じ記録を分けない。
 */
export async function planEditLockLossDeliveries(now: Date): Promise<number> {
  await recordExpiredEditLockLosses(prisma);
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "edit_lock_loss_events" WHERE "status" = 'pending' ORDER BY "occurred_at" ASC LIMIT 200 FOR UPDATE SKIP LOCKED`;
    if (locked.length === 0) return 0;
    const events = await tx.editLockLossEvent.findMany({ where: { id: { in: locked.map((l) => l.id) } } });
    const at = new Date(Math.max(now.getTime(), Date.now()));
    const cutoff = at.getTime() - EDIT_LOCK_LOSS_NOTIFY_WINDOW_MS;
    const live = events.filter((e) => e.occurredAt.getTime() >= cutoff);
    const stale = events.filter((e) => e.occurredAt.getTime() < cutoff);
    // 端末はまとめて読み、記録もまとめて書く(件数によらず問い合わせの回数を一定に)。
    const subs = live.length
      ? await tx.pushSubscription.findMany({
          where: { ...activeSubscriptionWhere(at), userId: { in: [...new Set(live.map((e) => e.userId))] } },
          select: { id: true, userId: true, bindingId: true, boundAt: true },
          orderBy: { id: "asc" },
        })
      : [];
    // 1回で作るのは「件×端末」で SOURCE_REFS_PER_TX まで(古い記録から・最低1件)。残りは pending のまま
    // 次の実行で分ける(端末の多い人が並んでもトランザクションが時間切れにならない・@codex #472 P2)。
    //   すでに作った端末は除いて数える。1件の端末が上限を超えるときは上限ぶんだけ作り、その記録は pending の
    //   まま次の実行で続ける(どの1件でも1回の量は上限まで・@codex #472 P2)。
    const already = live.length
      ? await tx.notificationDeliveryRef.findMany({
          where: { kind: "edit_lock_lost", refKey: { in: live.map((e) => editLockLossRefKey(e.id)) } },
          select: { refKey: true, bindingId: true },
        })
      : [];
    const made = new Set(already.map((r) => `${r.refKey}|${r.bindingId}`));
    const items: Array<{ sub: SubRef; refKeys: string[] }> = [];
    const done: string[] = [];
    for (const e of live) {
      const key = editLockLossRefKey(e.id);
      const mine = subs.filter(
        (s) => s.userId === e.userId && s.boundAt.getTime() <= e.occurredAt.getTime() && !made.has(`${key}|${s.bindingId}`),
      );
      const room = SOURCE_REFS_PER_TX - items.length;
      if (room <= 0) break;
      for (const s of mine.slice(0, room)) items.push({ sub: s, refKeys: [key] });
      if (mine.length > room) break;
      done.push(e.id);
    }
    const created = await createDeliveries(tx, items, "edit_lock_lost", at);
    if (stale.length) {
      await tx.editLockLossEvent.updateMany({ where: { id: { in: stale.map((e) => e.id) } }, data: { status: "expired", notifiedAt: at } });
    }
    if (done.length) {
      await tx.editLockLossEvent.updateMany({ where: { id: { in: done } }, data: { status: "queued", notifiedAt: at } });
    }
    return created;
  }, TX_OPTS);
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
  /** 確かめた人(送り先になれたかどうかによらない)。見つけた時点でこれ以外の人の端末があれば、記録しない。 */
  considered: Set<string>;
}

/**
 * `deadlineMs` を過ぎたら途中でやめて null を返す(呼び出し側はその回の記録づくりをしない=
 * 一部の人だけで出来事を「見つけ済み」にしない)。
 */
export async function loadSourceRecipients(source: Source, deadlineMs?: number): Promise<SourceRecipients | null> {
  // 送ってよい端末を持つ人だけを見る(端末の無い人は送り先にならない=全員を確かめない・@codex #472 P2)。
  // 申込は通知 ON の人だけが対象(先に絞る)。確かめるのは処理する出来事に要る区分だけ(@codex #472 P2)。
  const users = await prisma.user.findMany({
    where: {
      isActive: true,
      ...(source === "inquiry" ? { inquiryNotifyEnabled: true } : {}),
      pushSubscriptions: { some: { revokedAt: null, expiresAt: { gt: new Date() } } },
    },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const inquiry: Recipient[] = [];
  const registry = new Map<string, Recipient>();
  const considered = new Set(users.map((u) => u.id));
  for (const u of users) {
    if (deadlineMs !== undefined && Date.now() >= deadlineMs) return null;
    const r = await loadRecipient(prisma, u.id);
    if (!r) continue;
    if (source === "inquiry") {
      if (await canReceiveInquiryNotice(r)) inquiry.push(r);
    } else if (canReceiveRegistryNotice(r)) {
      registry.set(r.id, r);
    }
  }
  return { inquiry, registry, considered };
}

export async function planSourceDeliveries(
  source: Source,
  now: Date,
  recipients?: SourceRecipients,
): Promise<{ created: number; more: boolean }> {
  const who = recipients ?? (await loadSourceRecipients(source));
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
    // 顔ぶれを求めたあと、見つけた時点までに初めて端末を結び付けた人がいれば、その人を確かめていない。
    // このまま見つけ済みにすると、その人の端末には永久に届かないので、今回は何も書かずに求め直させる
    // (@codex #472 P2)。
    const newcomer = await tx.pushSubscription.findFirst({
      where: {
        ...activeSubscriptionWhere(seenAt),
        boundAt: { lte: seenAt },
        userId: { notIn: [...who.considered] },
        ...(source === "inquiry" ? { user: { isActive: true, inquiryNotifyEnabled: true } } : {}),
      },
      select: { id: true },
    });
    if (newcomer) return { created: 0, more: true };
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

    if (take.length > 0) {
      const fresh = take.map((r) => r.id);
      await tx.notificationSourceEvent.createMany({
        data: fresh.map((eventId) => ({ source, eventId, firstSeenAt: seenAt })),
        skipDuplicates: true,
      });
      // 見つけた時点の送り先(端末)を控えに書き出す(以後はこの顔ぶれのまま少しずつ記録を作る=途中で
      // 結び付いた端末や、あとから送り先になった人は加えない・@codex #472 P2)。
      if (source === "inquiry") await enqueueInquiries(tx, fresh, seenAt, who.inquiry);
      else await enqueueRegistryJobs(tx, fresh, seenAt, who.registry);
    }
    // 控えから、1回「件×端末」で SOURCE_REFS_PER_TX まで送信記録を作る(残りは次の回で)。
    const drained = await drainFanout(tx, source, seenAt);
    const created = drained.created;
    // カーソルは「カーソルより後」のうち、まだ処理していない新しい出来事の手前までだけ進める。
    const firstPending = more ? freshRows[take.length] : null;
    const pendingIdx = firstPending ? after.findIndex((r) => r.id === firstPending.id) : -1;
    const done = firstPending ? (pendingIdx < 0 ? [] : after.slice(0, pendingIdx)) : after;
    const next = advanceCursor(c, done.map((r) => ({ t: r.t, i: r.id })));
    await tx.notificationSourceCursor.update({ where: { source }, data: { cursorT: next.t, cursorId: next.i, updatedAt: now } });
    // カーソルより後が上限まで埋まっていたら、その先にもまだある(続けて読む)。
    return { created, more: more || drained.more || after.length >= AFTER_CURSOR_LIMIT };
  }, { timeout: SOURCE_PLAN_TX_TIMEOUT_MS, maxWait: SEND_TX_MAX_WAIT_MS });
}

/** 出来事1件の送り先(端末)を控えに書き出す。見つけた時点で結び付いている端末だけ(1文でまとめて)。 */
async function enqueue(tx: Tx, source: Source, eventId: string, userIds: string[], seenAt: Date): Promise<void> {
  if (userIds.length === 0) return;
  const at = seenAt.toISOString();
  await tx.$executeRaw`
    INSERT INTO "notification_fanout_queue" ("id", "source", "event_id", "subscription_id", "binding_id", "user_id", "created_at")
    SELECT gen_random_uuid(), ${source}, ${eventId}::uuid, s."id", s."binding_id", s."user_id", (${at}::timestamptz AT TIME ZONE 'UTC')
    FROM "push_subscriptions" s JOIN "users" u ON u."id" = s."user_id" AND u."is_active"
    WHERE s."user_id" = ANY(${userIds}::uuid[]) AND s."revoked_at" IS NULL
      AND s."expires_at" > (${at}::timestamptz AT TIME ZONE 'UTC') AND s."bound_at" <= (${at}::timestamptz AT TIME ZONE 'UTC')
    ON CONFLICT DO NOTHING`;
}

async function enqueueInquiries(tx: Tx, inquiryIds: string[], seenAt: Date, recipients: Recipient[]): Promise<void> {
  const inquiries = await tx.dmInquiry.findMany({
    where: { id: { in: inquiryIds } },
    select: { id: true, draft: { select: { property: { select: { createdBy: true, assignedTo: true } } } } },
  });
  for (const q of inquiries) {
    const users = recipients.filter((r) => inquiryInScope(r, q.draft?.property ?? null)).map((r) => r.id);
    await enqueue(tx, "inquiry", q.id, users, seenAt);
  }
}

async function enqueueRegistryJobs(tx: Tx, jobIds: string[], seenAt: Date, recipients: Map<string, Recipient>): Promise<void> {
  const jobs = await tx.registryFetchJob.findMany({ where: { id: { in: jobIds } }, select: { id: true, requestedById: true } });
  for (const j of jobs) {
    if (j.requestedById && recipients.has(j.requestedById)) await enqueue(tx, "registry_job", j.id, [j.requestedById], seenAt);
  }
}

/**
 * 控えから、古い順に SOURCE_REFS_PER_TX 件まで送信記録を作り、作った分の控えを消す。
 * 申込は端末ごとに1通へまとめ(1通は DELIVERY_REFS_MAX 件まで)、謄本ジョブはジョブごとに1通。
 */
async function drainFanout(tx: Tx, source: Source, now: Date): Promise<{ created: number; more: boolean }> {
  const rows = await tx.$queryRaw<Array<{ id: string; event_id: string; subscription_id: string; binding_id: string; user_id: string }>>`
    SELECT "id", "event_id", "subscription_id", "binding_id", "user_id" FROM "notification_fanout_queue"
    WHERE "source" = ${source}
    ORDER BY "created_at" ASC, "id" ASC
    LIMIT ${SOURCE_REFS_PER_TX}
    FOR UPDATE SKIP LOCKED`;
  if (rows.length === 0) return { created: 0, more: false };
  const kind = kindOfSource(source);
  let items: Array<{ sub: SubRef; refKeys: string[] }>;
  if (source === "inquiry") {
    const bySub = new Map<string, { sub: SubRef; refKeys: string[] }>();
    for (const r of rows) {
      const cur = bySub.get(r.subscription_id) ?? { sub: { id: r.subscription_id, userId: r.user_id, bindingId: r.binding_id }, refKeys: [] };
      cur.refKeys.push(eventRefKey("inquiry", r.event_id));
      bySub.set(r.subscription_id, cur);
    }
    items = [...bySub.values()];
  } else {
    items = rows.map((r) => ({ sub: { id: r.subscription_id, userId: r.user_id, bindingId: r.binding_id }, refKeys: [eventRefKey("registry_job", r.event_id)] }));
  }
  const created = await createDeliveries(tx, items, kind, now);
  await tx.notificationFanoutQueue.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
  return { created, more: rows.length >= SOURCE_REFS_PER_TX };
}
