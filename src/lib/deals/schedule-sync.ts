import { createHash, randomInt } from "crypto";
import prisma from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma";
import { writeAuditLog } from "@/lib/audit";
import { jstDateToDbDate } from "@/lib/notifications/reminder-schedule";
import { kindBaseOf, type BasePropertyKind } from "./constants";
import { buildCrosscheck, type RegistryFacts } from "./crosscheck";
import { loadCrosscheckRegistry } from "./crosscheck-load";
import { applyTargetParcels, readTargetParcels } from "./target-parcels";
import { jstDateString } from "./datetime";
import { dealTitle } from "./deal-title";
import { loadDealSettings } from "./settings-store";
import {
  applyScheduleEvents, isCompletionHint, mortgageStateOf, reconcileSchedule, type CompletionHint, type MortgageState, type ScheduleEvent,
  type ScheduleItemPatch, type ScheduleItemState,
} from "./schedule";
import type { PropertySnapshot } from "./schemas";
import { templatesForItem, type RequestTemplate } from "./request-drafts/templates";

/**
 * 段取りと DB をつなぐ。判定は schedule.ts の純関数。
 * ⚠担保の判定は謄本 PDF を読む(土地のある物件は最大20通)のでトランザクションの外で行い、読んだ謄本の印が
 *   同じあいだは読み直さない。結果は有無だけで、件数・抵当権者は控えない・返さない。
 */
interface ScheduleFacts {
  mortgage?: MortgageState;
  /** 判定に使った謄本の印(物件・種類・添付の ID のハッシュ)。 */
  fingerprint?: string;
  /** 朝の見回りを済ませた日。 */
  sweptOn?: string;
}

function parseFacts(raw: unknown): ScheduleFacts {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const mortgage = r.mortgage === "yes" || r.mortgage === "no" || r.mortgage === "unknown" ? r.mortgage : undefined;
  return {
    ...(mortgage ? { mortgage } : {}),
    ...(typeof r.fingerprint === "string" ? { fingerprint: r.fingerprint } : {}),
    ...(typeof r.sweptOn === "string" ? { sweptOn: r.sweptOn } : {}),
  };
}

/**
 * 判定に使った謄本の印。この取引の土地・建物を選んでいれば、その選びと、物件の土地・建物の今の値も入れる
 * (選びを変えた・行を直した=読み直す)。選んでいない取引は今までと同じ印(全部の取引を読み直させない)。
 */
export async function registryFingerprint(propertyId: string, kindBase: BasePropertyKind | null, targetParcels: readonly string[] | null): Promise<string> {
  const [rows, parcels] = await Promise.all([
    prisma.attachment.findMany({
      where: { propertyId, type: "registry", isDeleted: false }, select: { id: true }, orderBy: { id: "asc" },
    }),
    targetParcels
      ? prisma.property.findUnique({ where: { id: propertyId }, select: { lotNumber: true, buildingNumber: true, extraParcels: true } })
      : Promise.resolve(null),
  ]);
  const scope = targetParcels ? [JSON.stringify([targetParcels, parcels ? applyTargetParcels(parcels, targetParcels) : null])] : [];
  return createHash("sha256").update([propertyId, kindBase ?? "", ...rows.map((r) => r.id), ...scope].join("|")).digest("hex");
}

/** 照合の判定をそのまま使う(取引の値は比べない=注意と謄本の状態だけを読む)。 */
export async function readMortgageState(
  propertyId: string, kindBase: BasePropertyKind | null, targetParcels: readonly string[] | null = null,
): Promise<MortgageState> {
  let registry: RegistryFacts;
  try {
    registry = await loadCrosscheckRegistry(propertyId, { kindBase, includeOwners: false, targetParcels });
  } catch {
    // 中身に氏名が入りうるので例外は出さない。
    registry = { status: "unreadable" };
  }
  return mortgageStateOf(buildCrosscheck({
    kindBase, price: null, settlementDate: null, registry,
    sellerCompare: "denied", sellers: [], documents: [],
  }));
}

const jsonObject = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** 固定資産税と都市計画税の両方が入っているか。 */
export function taxesEnteredOf(settlementTerms: unknown): boolean {
  const t = jsonObject(settlementTerms);
  return typeof t.fixedAssetTax === "number" && typeof t.cityPlanningTax === "number";
}

export interface SyncOptions {
  now?: Date;
  /** 操作した人(監査用)。朝の見回りは無し。 */
  userId?: string | null;
  event?: ScheduleEvent;
  /** false=謄本を読まない(見回りの1回あたりの上限)。 */
  allowRead?: boolean;
  /** 判定できない取引も読み直す(一時的に読めなかっただけのことがある。朝の見回りだけ)。 */
  retryUnknown?: boolean;
  /** 朝の見回りの印を付ける。 */
  markSwept?: boolean;
}

const stateOf = (r: {
  id: string; templateKey: string | null; dueDate: Date; dueManual: boolean; assigneeId: string | null; assigneeManual: boolean; completedAt: Date | null;
  excludedAt: Date | null; excludedManual: boolean; preIntroduction: boolean; mortgageUnknown: boolean; completionHint: string | null;
}): ScheduleItemState => ({
  id: r.id, templateKey: r.templateKey, dueDate: r.dueDate.toISOString().slice(0, 10), dueManual: r.dueManual, assigneeId: r.assigneeId, assigneeManual: r.assigneeManual,
  completed: r.completedAt !== null, excluded: r.excludedAt !== null, excludedManual: r.excludedManual, preIntroduction: r.preIntroduction, mortgageUnknown: r.mortgageUnknown,
  completionHint: isCompletionHint(r.completionHint) ? r.completionHint : null,
});

function patchData(p: ScheduleItemPatch, now: Date) {
  const { dueDate, excluded, ...rest } = p;
  return {
    ...rest,
    ...(dueDate !== undefined ? { dueDate: jstDateToDbDate(dueDate) } : {}),
    ...(excluded !== undefined ? { excludedAt: excluded ? now : null } : {}),
  };
}

/**
 * 取引の行を押さえて項目を書く。同期も手の変更もこれを通す(同期が読んだあとに手で直した期限や担当を、
 * 古い読み取りで上書きしない・@codex #626 P2)。
 */
export function withDealLock<T>(dealId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "deals" WHERE "id" = ${dealId}::uuid FOR UPDATE`;
    return fn(tx);
  });
}

/** 取引の今の日付と条件に項目を合わせ、出来事があれば自動の完了も行う。戻り値 readSkipped=読むべき謄本を読まなかった。 */
export async function syncDealSchedule(dealId: string, o: SyncOptions = {}): Promise<{ read: boolean; readSkipped: boolean }> {
  const now = o.now ?? new Date();
  const today = jstDateString(now);
  const base = await prisma.deal.findUnique({
    where: { id: dealId }, select: { propertyId: true, propertyKind: true, scheduleFacts: true, contractAt: true, settlementAt: true, targetParcels: true },
  });
  if (!base) return { read: false, readSkipped: false };
  const settings = await loadDealSettings();
  const kindBase = kindBaseOf(settings, base.propertyKind);
  const facts = parseFacts(base.scheduleFacts);
  const usesMortgage = settings.scheduleTemplate.some((t) => t.condition === "active_mortgage");
  const targetParcels = readTargetParcels(base.targetParcels);

  // 担保の判定はトランザクションの外で。日付が無ければ項目を作らないので読まない。
  let mortgage: MortgageState = facts.mortgage ?? "unknown";
  let fingerprint = facts.fingerprint;
  let read = false;
  let readSkipped = false;
  if (!base.propertyId) {
    mortgage = "unknown";
    fingerprint = undefined;
  } else if (usesMortgage && (base.contractAt || base.settlementAt)) {
    const fp = await registryFingerprint(base.propertyId, kindBase, targetParcels);
    if (fp !== facts.fingerprint || !facts.mortgage || (o.retryUnknown && facts.mortgage === "unknown")) {
      if (o.allowRead === false) {
        readSkipped = true;
      } else {
        mortgage = await readMortgageState(base.propertyId, kindBase, targetParcels);
        fingerprint = fp;
        read = true;
      }
    }
  }

  // 読む枠が無かった回は何も変えない(判定できない扱いで担保の項目を作らない・次の実行で読む)。
  if (readSkipped) return { read, readSkipped };

  await withDealLock(dealId, async (tx) => {
    const d = await tx.deal.findUnique({
      where: { id: dealId },
      select: {
        businessType: true, tradeSide: true, propertyKind: true, hasOc: true, status: true, contractAt: true, settlementAt: true,
        assigneeId: true, salesStaffId: true, opsStaffId: true, createdById: true, settlementTerms: true, scheduleFacts: true,
      },
    });
    if (!d) return;
    const rows = await tx.dealScheduleItem.findMany({ where: { dealId } });
    const issued = await tx.dealDocument.findMany({ where: { dealId }, distinct: ["docType"], select: { docType: true } });
    const { creates, updates } = reconcileSchedule({
      template: settings.scheduleTemplate, mortgage, items: rows.map(stateOf), today, issuedDocTypes: issued.map((x) => x.docType), taxesEntered: taxesEnteredOf(d.settlementTerms),
      deal: {
        businessType: d.businessType, tradeSide: d.tradeSide, kindBase: kindBaseOf(settings, d.propertyKind), hasOc: d.hasOc, status: d.status,
        contractDate: d.contractAt ? jstDateString(d.contractAt) : null, settlementDate: d.settlementAt ? jstDateString(d.settlementAt) : null,
        assigneeId: d.assigneeId, salesStaffId: d.salesStaffId, opsStaffId: d.opsStaffId, createdById: d.createdById,
      },
    });
    if (creates.length) {
      await tx.dealScheduleItem.createMany({
        skipDuplicates: true,
        data: creates.map((c) => ({
          dealId, templateKey: c.templateKey, label: c.label, base: c.base, dueDate: jstDateToDbDate(c.dueDate), assigneeId: c.assigneeId, sortOrder: c.sortOrder,
          preIntroduction: c.preIntroduction, mortgageUnknown: c.mortgageUnknown, completionHint: c.completionHint,
          completedAt: c.completed ? now : null, autoCompleted: c.completed,
        })),
      });
    }
    for (const u of updates) await tx.dealScheduleItem.updateMany({ where: { id: u.id, dealId }, data: patchData(u.data, now) });
    if (o.event && d.status !== "cancelled") {
      const after = await tx.dealScheduleItem.findMany({ where: { dealId } });
      for (const e of applyScheduleEvents(after.map(stateOf), o.event)) {
        await tx.dealScheduleItem.updateMany({
          where: { id: e.id, dealId },
          data: "completed" in e.data ? { completedAt: now, autoCompleted: true, completionHint: null } : { completionHint: e.data.completionHint },
        });
      }
    }
    const nextFacts: ScheduleFacts = {
      mortgage, ...(fingerprint ? { fingerprint } : {}),
      ...(o.markSwept ? { sweptOn: today } : parseFacts(d.scheduleFacts).sweptOn ? { sweptOn: parseFacts(d.scheduleFacts).sweptOn } : {}),
    };
    if (JSON.stringify(nextFacts) !== JSON.stringify(parseFacts(d.scheduleFacts))) {
      // 版の番号は進めない(見回りで、編集中の人の保存を 409 にしない)。
      await tx.deal.updateMany({ where: { id: dealId }, data: { scheduleFacts: nextFacts as object } });
    }
  });

  if (read) {
    await writeAuditLog({
      userId: o.userId ?? null, action: "deal_schedule_registry_read", targetTable: "deals", targetId: dealId, detail: { result: mortgage },
    });
  }
  return { read, readSkipped };
}

/** 取引の保存・発行のあとに呼ぶ。失敗しても元の操作は止めない(次に開いたとき・翌朝の見回りで直る)。 */
export async function syncDealScheduleSafe(dealId: string, o: SyncOptions = {}): Promise<void> {
  try {
    await syncDealSchedule(dealId, o);
  } catch {
    console.warn("deal_schedule_sync_failed");
  }
}

/** 案件ステータスの連動で取引の状態が動いたあとに呼ぶ(決済済になったら「決済・引渡し」を完了にする)。 */
export function syncDealScheduleAfterCaseStatus(change: { dealId: string; status: string } | null | undefined, userId: string): Promise<void> {
  if (!change) return Promise.resolve();
  return syncDealScheduleSafe(change.dealId, { userId, event: { settled: change.status === "settled" } });
}

/** 朝の見回りを始める時刻(日本時間 6:00=9:00 の通知の前に済ませる)。 */
const SWEEP_START_HOUR_JST = 6;
const SWEEP_DEALS_PER_RUN = 20;
const SWEEP_READS_PER_RUN = 3;

/**
 * 朝の見回り: 中止を除き決済日が今日以降の取引を、1日に1回同期する(既存の取引の段取りもここで作られる)。
 * 定期実行(2分ごと)の中で少しずつ進め、謄本を読むのは1回に3件まで。
 */
export async function sweepDealSchedules(now: Date, opts: { deadlineMs?: number } = {}): Promise<number> {
  const today = jstDateString(now);
  if (now.getTime() < Date.parse(`${today}T0${SWEEP_START_HOUR_JST}:00:00.000+09:00`)) return 0;
  const rows = await prisma.deal.findMany({
    where: { status: { not: "cancelled" }, settlementAt: { gte: new Date(`${today}T00:00:00.000+09:00`) } },
    select: { id: true, scheduleFacts: true },
    orderBy: { settlementAt: "asc" },
  });
  const left = rows.filter((r) => parseFacts(r.scheduleFacts).sweptOn !== today);
  // 始める位置は毎回ずらす(失敗し続ける取引が先頭に並んでも、後ろの取引を止めない)。
  const start = left.length ? randomInt(left.length) : 0;
  const pending = [...left.slice(start), ...left.slice(0, start)].slice(0, SWEEP_DEALS_PER_RUN);
  let reads = 0;
  let done = 0;
  for (const r of pending) {
    if (opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs) break;
    try {
      const res = await syncDealSchedule(r.id, { now, allowRead: reads < SWEEP_READS_PER_RUN, retryUnknown: true, markSwept: true });
      if (res.read) reads += 1;
      if (!res.readSkipped) done += 1;
    } catch {
      // 1件の失敗で全体を止めない(次の実行でもう一度)。中身は出さない。
      console.warn("deal_schedule_sweep_failed");
    }
  }
  return done;
}

// ---------- 画面に渡す形 ----------

export interface ScheduleItemView {
  id: string;
  label: string;
  base: string | null;
  dueDate: string;
  dueManual: boolean;
  isManual: boolean;
  assigneeId: string | null;
  assigneeName: string | null;
  completed: boolean;
  autoCompleted: boolean;
  excluded: boolean;
  preIntroduction: boolean;
  mortgageUnknown: boolean;
  completionHint: CompletionHint | null;
  /** 結びついた依頼文のひな形の数。 */
  requestTemplates?: number;
}

export async function loadScheduleItems(dealId: string, requestTemplates: readonly RequestTemplate[] = []): Promise<ScheduleItemView[]> {
  const rows = await prisma.dealScheduleItem.findMany({
    where: { dealId }, orderBy: [{ dueDate: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
    include: { assignee: { select: { name: true } } },
  });
  return rows.map((r) => {
    const s = stateOf(r);
    return {
      id: r.id, label: r.label, base: r.base, dueDate: s.dueDate, dueManual: r.dueManual, isManual: r.templateKey === null, assigneeId: r.assigneeId, assigneeName: r.assignee?.name ?? null,
      completed: s.completed, autoCompleted: r.autoCompleted, excluded: s.excluded, preIntroduction: r.preIntroduction, mortgageUnknown: r.mortgageUnknown, completionHint: s.completionHint,
      requestTemplates: templatesForItem(requestTemplates, r.templateKey).length,
    };
  });
}

/** ホームの見出し(一覧と同じ見せ方)。 */
export const scheduleDealTitle = (d: { name: string; propertySnapshot: unknown }): string =>
  dealTitle({ name: d.name, propertySnapshot: jsonObject(d.propertySnapshot) as Pick<PropertySnapshot, "buildingName" | "roomNo" | "address"> });
