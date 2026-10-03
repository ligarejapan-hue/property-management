/**
 * 通知 段階4b: 誰に・どの件を送ってよいか(設計書 §9)。送り先を決めるときと、**送る直前の確かめ直し**
 * (§7.4・§9)の両方で同じ関数を使う。判定は段階2の件数の窓口(`summary.ts`)と同じ規則
 * (新しい規則を作らない):
 * - 次回対応 = property:read + 物件の担当範囲(field_staff は作成か担当の物件だけ)+ 担当者が本人。
 * - 査定申込 = 申込一覧と同じ requireSaleDmAccess の条件 + field_staff は担当範囲 + 管理者が通知 ON にした人。
 * - 謄本ジョブ = registry:auto_fetch + property:read + 作成者本人 + 項目ごとに今見られる物件だけで数え直す。
 * - どれも在籍中(isActive)の人だけ。
 */
import type { Prisma } from "@/generated/prisma";
import { getUserPermissions } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { propertyRecordScopeFilter } from "@/lib/property-record-guard";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { checkSaleDmAccessFor } from "@/lib/sale-dm-letter/route-guard";
import { recomputeCounts } from "@/lib/registry-fetch/bulk/jobs";
import {
  isTimedNextAction,
  jstDateToDbDate,
  jstToday,
  nextActionDeadline,
  nextActionReminderSlot,
  reminderSendOffsets,
} from "@/lib/notifications/reminder-schedule";

type Db = Prisma.TransactionClient;
type PermissionList = Awaited<ReturnType<typeof getUserPermissions>>;

const DAY = 24 * 60 * 60 * 1000;

export interface Recipient {
  id: string;
  role: string;
  inquiryNotifyEnabled: boolean;
  permissions: PermissionList;
}

/** 在籍中の利用者と、その今の権限。在籍していなければ null。 */
export async function loadRecipient(db: Db, userId: string): Promise<Recipient | null> {
  const u = await db.user.findUnique({ where: { id: userId }, select: { id: true, role: true, isActive: true, inquiryNotifyEnabled: true } });
  if (!u || !u.isActive) return null;
  const permissions = await getUserPermissions(u.id);
  return { id: u.id, role: u.role, inquiryNotifyEnabled: u.inquiryNotifyEnabled, permissions };
}

// ---------- 次回対応(N4・N5) ----------

export interface DueNextAction {
  id: string;
  deadline: number;
  revMs: number;
  slot: number;
  /** その回の送る時刻(ms)。端末の結び付けより前の回は送らない(§7.3)。 */
  slotTime: number;
  /** 時刻ありの「5分前」の回だけ時刻("HH:MM")。 */
  dueTime?: string;
}

function nextActionWhere(r: Recipient) {
  const scope = propertyRecordScopeFilter(r);
  return { assignedTo: r.id, isCompleted: false, ...(scope ? { property: scope } : {}) };
}

/** 今が送信予定のどれかの回に当たっている、本人の未完了の次回対応(段階2の件数の窓口と同じ範囲)。 */
export async function dueNextActions(db: Db, r: Recipient, now: Date, ids?: string[]): Promise<DueNextAction[]> {
  if (!hasPermission(r.permissions, "property", "read")) return [];
  const todayDb = jstDateToDbDate(jstToday(now));
  const rows = await db.nextAction.findMany({
    where: {
      ...nextActionWhere(r),
      // 期限から1週間で止まるので8日前まで・時刻ありの 0:00〜0:04 は前日の夜に5分前の回が来るので明日まで。
      scheduledAt: { gte: new Date(todayDb.getTime() - 8 * DAY), lte: new Date(todayDb.getTime() + DAY) },
      ...(ids ? { id: { in: ids } } : {}),
    },
    select: { id: true, scheduledAt: true, scheduledTime: true, updatedAt: true, reminderRevAt: true },
    orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
  });
  const out: DueNextAction[] = [];
  for (const row of rows) {
    const timed = isTimedNextAction(row.scheduledTime);
    const deadline = nextActionDeadline(row.scheduledAt, row.scheduledTime);
    const slot = nextActionReminderSlot(deadline, now.getTime(), { timed });
    if (slot === null) continue;
    out.push({
      id: row.id,
      deadline,
      revMs: (row.reminderRevAt ?? row.updatedAt).getTime(),
      slot,
      slotTime: deadline + reminderSendOffsets(timed)[slot],
      ...(timed && slot === 0 ? { dueTime: row.scheduledTime as string } : {}),
    });
  }
  return out;
}

/** 本文の「今日の次回対応が3件、期限切れが1件」の件数(ベル・ホームと同じ数え方)。 */
export async function nextActionCounts(db: Db, r: Recipient, now: Date): Promise<{ today: number; overdue: number }> {
  const todayDb = jstDateToDbDate(jstToday(now));
  const base = nextActionWhere(r);
  const [today, overdue] = await Promise.all([
    db.nextAction.count({ where: { ...base, scheduledAt: todayDb } }),
    db.nextAction.count({ where: { ...base, scheduledAt: { lt: todayDb } } }),
  ]);
  return { today, overdue };
}

// ---------- 査定申込(N6) ----------

/** 新着の申込を知らせてよい人か(在籍・通知 ON・申込一覧を見られる)。 */
export async function canReceiveInquiryNotice(r: Recipient): Promise<boolean> {
  if (!r.inquiryNotifyEnabled) return false;
  try {
    const access = await checkSaleDmAccessFor(r.id);
    return access.ok;
  } catch {
    return false;
  }
}

/** その申込が本人の見える範囲にあるか(field_staff は申込の物件の作成か担当)。 */
export function inquiryInScope(r: Recipient, property: { createdBy: string | null; assignedTo: string | null } | null): boolean {
  if (r.role !== "field_staff") return true;
  return !!property && (property.createdBy === r.id || property.assignedTo === r.id);
}

export async function visibleInquiryIds(db: Db, r: Recipient, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db.dmInquiry.findMany({
    where: { id: { in: ids } },
    select: { id: true, draft: { select: { property: { select: { createdBy: true, assignedTo: true } } } } },
  });
  return new Set(rows.filter((x) => inquiryInScope(r, x.draft?.property ?? null)).map((x) => x.id));
}

// ---------- 謄本の一括取得の完了(N7) ----------

export function canReceiveRegistryNotice(r: Recipient): boolean {
  return hasPermission(r.permissions, "registry", "auto_fetch") && hasPermission(r.permissions, "property", "read");
}

/** 本人が作った完了済みジョブの、今見られる物件の項目だけで数え直した件数。見られる項目が無ければ null。 */
export async function registryJobVisibleCounts(
  db: Db,
  r: Recipient,
  jobId: string,
): Promise<{ done: number; failed: number; skipped: number; chargedButFailed: number } | null> {
  const job = await db.registryFetchJob.findUnique({ where: { id: jobId }, select: { requestedById: true, status: true } });
  if (!job || job.requestedById !== r.id || job.status !== "completed") return null;
  const items = await db.registryFetchJobItem.findMany({
    where: { jobId },
    select: { status: true, property: { select: { createdBy: true, assignedTo: true } } },
  });
  const visible = items.filter((it) => it.property !== null && canAccessPropertyRecord(r, it.property));
  if (visible.length === 0) return null;
  const c = recomputeCounts(visible);
  return { done: c.done, failed: c.failed, skipped: c.skipped, chargedButFailed: c.chargedButFailed };
}
