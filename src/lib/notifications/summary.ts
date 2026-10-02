/**
 * 通知 段階2の件数の窓口(`GET /api/notifications/summary`)の中身(設計書 §5.1)。
 *
 * - 返すのは件数・不透明な値・時刻だけ。物件名・住所・申込者名などの PII は返さない。
 * - 区分ごとに、今の一覧と**同じ権限判定**を使う(新しい規則を作らない・設計書 §9)。
 *   見られない区分は null。
 */
import prisma from "@/lib/prisma";
import { ApiError } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { propertyRecordScopeFilter } from "@/lib/property-record-guard";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { checkSaleDmAccessFor } from "@/lib/sale-dm-letter/route-guard";
import { recomputeCounts } from "@/lib/registry-fetch/bulk/jobs";
import {
  BOUNDARY_UUID,
  decodeEventCursor,
  encodeEventCursor,
  seenKey,
  type CursorKind,
  type EventCursor,
  type NotificationKeys,
} from "./opaque";
import {
  AFTER_CURSOR_LIMIT,
  REREAD_PAGE,
  advanceCursor,
  afterCursorWhere,
  pageAfterWhere,
  rereadWhere,
} from "./event-cursor";
import { jstDateToDbDate, jstToday, nextActionDeadline, nextActionReminderSlot } from "./reminder-schedule";

type PermissionList = Parameters<typeof hasPermission>[0];

export interface SummarySession {
  id: string;
  role: string;
}

export interface NextActionSummary {
  today: number;
  overdue: number;
  reminders: Array<{ key: string; slot: number }>;
}

export interface InquirySummary {
  open: number;
  /** 新着の見た印。通知を受け取る設定(inquiryNotifyEnabled)の人にだけ返す。 */
  newKeys: string[] | null;
  cursor: string | null;
  cursorAt: number | null;
  initialSeenKeys?: string[];
}

export interface RegistryJobSummary {
  completed: Array<{ key: string; href: string; done: number; failed: number; skipped: number; chargedButFailed: number }>;
  cursor: string;
  cursorAt: number;
  initialSeenKeys?: string[];
}

export interface NotificationSummary {
  nextActions: NextActionSummary | null;
  inquiries: InquirySummary | null;
  registryJobs: RegistryJobSummary;
}

export interface SummaryInput {
  session: SummarySession;
  permissions: PermissionList;
  inquiryCursor: string | null;
  registryCursor: string | null;
  now: Date;
  keys: NotificationKeys;
}

const DAY = 24 * 60 * 60 * 1000;

export async function buildNotificationSummary(input: SummaryInput): Promise<NotificationSummary> {
  const [nextActions, inquiries, registryJobs] = await Promise.all([
    nextActionSummary(input),
    inquirySummary(input),
    registryJobSummary(input),
  ]);
  return { nextActions, inquiries, registryJobs };
}

// ---------- 次回対応(N4) ----------

async function nextActionSummary({ session, permissions, now, keys }: SummaryInput): Promise<NextActionSummary | null> {
  // 次回対応 API(GET /api/properties/[id]/next-actions)と同じ2段: property:read + 物件の担当範囲。
  if (!hasPermission(permissions, "property", "read")) return null;
  const scope = propertyRecordScopeFilter(session);
  const base = { assignedTo: session.id, isCompleted: false, ...(scope ? { property: scope } : {}) };
  const today = jstToday(now);
  const todayDb = jstDateToDbDate(today);
  // 知らせは期限(予定日の 9:00)から1週間で止まるので、8日前より古い予定日は回の計算に要らない。
  const oldest = new Date(todayDb.getTime() - 8 * DAY);
  const [todayCount, overdueCount, recent] = await Promise.all([
    prisma.nextAction.count({ where: { ...base, scheduledAt: todayDb } }),
    prisma.nextAction.count({ where: { ...base, scheduledAt: { lt: todayDb } } }),
    prisma.nextAction.findMany({
      where: { ...base, scheduledAt: { gte: oldest, lte: todayDb } },
      select: { id: true, scheduledAt: true, updatedAt: true },
      orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
    }),
  ]);
  const reminders: NextActionSummary["reminders"] = [];
  for (const r of recent) {
    const deadline = nextActionDeadline(r.scheduledAt);
    const slot = nextActionReminderSlot(deadline, now.getTime());
    if (slot === null) continue;
    // rev(担当と期限の版)は段階2では updatedAt のミリ秒までの ISO(設計書 §5.2)。
    reminders.push({
      key: seenKey(keys, session.id, "next_action", [r.id, String(deadline), r.updatedAt.toISOString(), String(slot)]),
      slot,
    });
  }
  return { today: todayCount, overdue: overdueCount, reminders };
}

// ---------- 新着の読み出し(申込・謄本ジョブ共通) ----------

type EventField = "submittedAt" | "completedAt";
type FetchPage = (where: object, take: number) => Promise<Array<{ id: string; t: Date }>>;

interface EventRead {
  cursor: EventCursor;
  /** 新しく返す行(①カーソルより後+②読み直し)。初回は空。 */
  rows: Array<{ id: string; t: Date }>;
  /** 初回だけ: 読み直し範囲にすでにある行(画面は見た扱いにする)。 */
  initialSeen: Array<{ id: string; t: Date }> | null;
}

/** ②読み直しを100件ずつめくって全件読む(件数で打ち切らない・設計書 §5.1)。 */
async function readAll(fetchPage: FetchPage, field: EventField, where: object): Promise<Array<{ id: string; t: Date }>> {
  const out: Array<{ id: string; t: Date }> = [];
  let last: EventCursor | null = null;
  for (;;) {
    const page = await fetchPage({ AND: [where, pageAfterWhere(field, last)] }, REREAD_PAGE);
    out.push(...page);
    if (page.length < REREAD_PAGE) return out;
    const tail = page[page.length - 1];
    last = { t: tail.t, i: tail.id };
  }
}

async function readEvents(args: {
  fetchPage: FetchPage;
  field: EventField;
  baseWhere: object;
  cursorRaw: string | null;
  kind: CursorKind;
  session: SummarySession;
  keys: NotificationKeys;
  now: Date;
}): Promise<EventRead> {
  const { fetchPage, field, baseWhere, cursorRaw, kind, session, keys, now } = args;
  if (cursorRaw === null) {
    // 初回: サーバーの今と境界値 UUID。読み直し範囲にすでにある出来事は見た扱いにさせる(設計書 §5.2)。
    const c0: EventCursor = { t: now, i: BOUNDARY_UUID };
    const seen = await readAll(fetchPage, field, { AND: [baseWhere, rereadWhere(field, c0)] });
    return { cursor: c0, rows: [], initialSeen: seen };
  }
  const c = decodeEventCursor(keys, session.id, kind, cursorRaw);
  // 読めないカーソルは初期化とみなさない(その間の新着を取りこぼすため)。
  if (!c) throw new ApiError(400, "通知の位置が読めません", "BAD_CURSOR");
  const [after, reread] = await Promise.all([
    fetchPage({ AND: [baseWhere, afterCursorWhere(field, c)] }, AFTER_CURSOR_LIMIT),
    readAll(fetchPage, field, { AND: [baseWhere, rereadWhere(field, c)] }),
  ]);
  const next = advanceCursor(c, after.map((r) => ({ t: r.t, i: r.id })));
  return { cursor: next, rows: [...after, ...reread], initialSeen: null };
}

// ---------- 査定申込(N6) ----------

async function inquirySummary({ session, inquiryCursor, now, keys }: SummaryInput): Promise<InquirySummary | null> {
  // 申込一覧 API と同じ: requireSaleDmAccess と同一の条件(checkSaleDmAccessFor)+ field_staff は担当範囲。
  let access;
  try {
    access = await checkSaleDmAccessFor(session.id);
  } catch {
    return null;
  }
  if (!access.ok) return null;
  const scopeWhere =
    session.role === "field_staff"
      ? { draft: { property: { OR: [{ createdBy: session.id }, { assignedTo: session.id }] } } }
      : {};
  const [open, user] = await Promise.all([
    prisma.dmInquiry.count({ where: { ...scopeWhere, handleStatus: "open" } }),
    prisma.user.findUnique({ where: { id: session.id }, select: { isActive: true, inquiryNotifyEnabled: true } }),
  ]);
  // 新着の知らせは、メール通知と同じく管理者が通知 ON にした在籍中の人だけ(設計書 §2 N6)。
  if (!user?.isActive || !user.inquiryNotifyEnabled) {
    return { open, newKeys: null, cursor: null, cursorAt: null };
  }
  const fetchPage: FetchPage = async (where, take) => {
    const rows = await prisma.dmInquiry.findMany({
      where,
      orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
      take,
      select: { id: true, submittedAt: true },
    });
    return rows.map((r) => ({ id: r.id, t: r.submittedAt }));
  };
  const read = await readEvents({ fetchPage, field: "submittedAt", baseWhere: scopeWhere, cursorRaw: inquiryCursor, kind: "inquiry", session, keys, now });
  const key = (id: string) => seenKey(keys, session.id, "inquiry", [id]);
  return {
    open,
    newKeys: read.rows.map((r) => key(r.id)),
    cursor: encodeEventCursor(keys, session.id, "inquiry", read.cursor),
    cursorAt: read.cursor.t.getTime(),
    ...(read.initialSeen ? { initialSeenKeys: read.initialSeen.map((r) => key(r.id)) } : {}),
  };
}

// ---------- 謄本の一括取得の完了(N7) ----------

async function registryJobSummary({ session, registryCursor, now, keys }: SummaryInput): Promise<RegistryJobSummary> {
  // ジョブは作成者本人だけ(getBulkJobProgress と同じ)。
  const baseWhere = { requestedById: session.id, status: "completed", completedAt: { not: null } };
  const fetchPage: FetchPage = async (where, take) => {
    const rows = await prisma.registryFetchJob.findMany({
      where,
      orderBy: [{ completedAt: "asc" }, { id: "asc" }],
      take,
      select: { id: true, completedAt: true },
    });
    return rows.filter((r) => r.completedAt !== null).map((r) => ({ id: r.id, t: r.completedAt as Date }));
  };
  const read = await readEvents({ fetchPage, field: "completedAt", baseWhere, cursorRaw: registryCursor, kind: "registry_job", session, keys, now });
  const key = (id: string) => seenKey(keys, session.id, "registry_job", [id]);
  const ids = [...new Set(read.rows.map((r) => r.id))];
  const completed: RegistryJobSummary["completed"] = [];
  if (ids.length > 0) {
    const items = await prisma.registryFetchJobItem.findMany({
      where: { jobId: { in: ids } },
      select: { jobId: true, status: true, property: { select: { createdBy: true, assignedTo: true } } },
    });
    for (const id of ids) {
      // 件数は今見られる物件の項目だけで数え直す(担当から外れた物件の結果を出さない・設計書 §5.1)。
      const visible = items.filter((it) => it.jobId === id && it.property !== null && canAccessPropertyRecord(session, it.property));
      if (visible.length === 0) continue;
      const c = recomputeCounts(visible);
      completed.push({
        key: key(id),
        href: `/properties/registry-fetch/${id}`,
        done: c.done,
        failed: c.failed,
        skipped: c.skipped,
        chargedButFailed: c.chargedButFailed,
      });
    }
  }
  return {
    completed,
    cursor: encodeEventCursor(keys, session.id, "registry_job", read.cursor),
    cursorAt: read.cursor.t.getTime(),
    ...(read.initialSeen ? { initialSeenKeys: read.initialSeen.map((r) => key(r.id)) } : {}),
  };
}
