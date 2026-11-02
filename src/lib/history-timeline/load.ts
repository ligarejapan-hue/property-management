import { z } from "zod";
import { writeAuditLog } from "@/lib/audit";
import { DEAL_STATUS_LABELS } from "@/lib/deals/constants";
import { loadDealSettings } from "@/lib/deals/settings-store";
import prisma from "@/lib/prisma";
import { CASE_STATUS_LABELS } from "@/lib/property-types";
import type { TimelineAccess } from "./access";
import {
  INVESTIGATION_ACTIONS, OWNER_INFO_SOURCES, TIMELINE_CATEGORIES, buildTimelineSummary, changeEvents, commentEvent, dealCreatedEvent,
  dmReactionEvent, dmSentEvent, docFileEvent, docLinkEvents, docReviewEvent, documentEvent, inquiryEvent, investigationEvent,
  materialSendEvent, mergeTimeline, nextActionCompletedEvent, nextActionCreatedEvent, ownerMemoEvent, requestCopyEvent, scheduleEvent,
  sourcesForCategory, userIdsInChanges, viewingEvent,
  type ChangeRow, type DealRef, type NextCandidate, type TimelineEvent, type TimelineFilter, type TimelineSource, type TimelineSummary,
} from "./events";

export const TIMELINE_PAGE_SIZE = 50;
/** 変更履歴はまとめる前の行数で読む(取込で1回に数十行あるため)。 */
const CHANGE_TAKE = 300;
/** 内見は日時が2列に分かれていて DB で並べられない=物件あたり少数なので読んでから並べる。 */
const VIEWING_TAKE = 200;

const querySchema = z.object({
  category: z.enum(["all", ...TIMELINE_CATEGORIES]).default("all"),
  before: z.string().datetime().optional(),
});

export function parseTimelineQuery(request: Request): { category: TimelineFilter; before?: string } {
  const params = new URL(request.url).searchParams;
  return querySchema.parse({ category: params.get("category") ?? undefined, before: params.get("before") ?? undefined });
}

export interface TimelineDeal {
  id: string;
  dealNo: string;
  status: string;
  createdAt: Date;
  createdBy: { name: string };
}
export interface TimelineScope {
  propertyId: string | null;
  buildingId: string | null;
  caseStatus: string | null;
  deals: TimelineDeal[];
}

const dealRef = (d: { id: string; dealNo: string }): DealRef => ({ id: d.id, label: `取引 ${d.dealNo}` });

/** 物件の出どころ。⚠ access で閉じた出どころはクエリを流さない。 */
async function loadPropertyEvents(propertyId: string, access: TimelineAccess, wants: (s: TimelineSource) => boolean, before: Date, take: number): Promise<TimelineEvent[]> {
  const tasks: Promise<TimelineEvent[]>[] = [];
  const lt = { lt: before };

  if (wants("comment")) {
    tasks.push(prisma.comment.findMany({
      where: { propertyId, createdAt: lt }, orderBy: { createdAt: "desc" }, take,
      select: { id: true, body: true, createdAt: true, parentId: true, author: { select: { name: true } } },
    }).then((rows) => rows.map((r) => commentEvent(r, propertyId))));
  }
  if (wants("owner_memo") && access.memo !== "hidden") {
    tasks.push((async () => {
      // この物件のメモと、物件を指定していないメモだけ(別の物件のメモは混ぜない・発注者決定 2026-11-02)。
      const links = await prisma.propertyOwner.findMany({ where: { propertyId }, select: { id: true, ownerId: true } });
      const ownerIds = links.map((l) => l.ownerId);
      const scope = [{ propertyId }, ...(ownerIds.length > 0 ? [{ ownerId: { in: ownerIds }, propertyId: null }] : [])];
      const rows = await prisma.ownerMemo.findMany({
        where: { OR: scope, createdAt: lt }, orderBy: { createdAt: "desc" }, take,
        select: { id: true, body: true, createdAt: true, creator: { select: { name: true } } },
      });
      return rows.map((r) => ownerMemoEvent(r, access.memo, propertyId));
    })());
  }
  if (access.dm && wants("dm")) {
    tasks.push(prisma.propertyDmLog.findMany({
      where: { propertyId, sentAt: lt }, orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }], take,
      select: { id: true, sentAt: true, method: true, note: true, sender: { select: { name: true } } },
    }).then((rows) => rows.map((r) => dmSentEvent(r, access.noteLevel, propertyId))));
  }
  if (access.dm && wants("dm_reaction")) {
    tasks.push(prisma.propertyDmLog.findMany({
      where: { propertyId, reactedAt: lt, reactionStatus: { not: "no_response" } }, orderBy: { reactedAt: "desc" }, take,
      select: { id: true, reactedAt: true, reactionStatus: true, reactionNote: true },
    }).then((rows) => rows.flatMap((r) => (r.reactedAt ? [dmReactionEvent({ ...r, reactedAt: r.reactedAt }, access.noteLevel, propertyId)] : []))));
  }
  if (wants("inquiry")) {
    tasks.push(prisma.agentInquiry.findMany({
      where: { propertyId, receivedAt: lt }, orderBy: { receivedAt: "desc" }, take,
      select: { id: true, kind: true, receivedAt: true, contactName: true, agent: { select: { companyName: true } }, createdBy: { select: { name: true } } },
    }).then((rows) => rows.map((r) => inquiryEvent(r, propertyId))));
  }
  if (wants("viewing")) {
    tasks.push(prisma.agentViewing.findMany({
      where: { inquiry: { propertyId }, OR: [{ scheduledAt: lt }, { scheduledAt: null, createdAt: lt }] }, orderBy: { createdAt: "desc" }, take: VIEWING_TAKE,
      select: {
        id: true, scheduledAt: true, createdAt: true, canceledAt: true, resultNote: true, attendant: { select: { name: true } },
        inquiry: { select: { agent: { select: { companyName: true } } } },
      },
    }).then((rows) => rows.map((r) => viewingEvent(r, propertyId))));
  }
  if (access.material && wants("material_send")) {
    tasks.push(prisma.agentInquiryMaterialSend.findMany({
      where: { inquiry: { propertyId }, createdAt: lt, result: { in: ["sent", "failed"] } }, orderBy: { createdAt: "desc" }, take,
      select: { id: true, createdAt: true, result: true, sentBy: { select: { name: true } }, inquiry: { select: { agent: { select: { companyName: true } } } } },
    }).then((rows) => rows.map((r) => materialSendEvent(r, propertyId))));
  }
  if (wants("next_action")) {
    tasks.push(prisma.nextAction.findMany({
      where: { propertyId, createdAt: lt }, orderBy: { createdAt: "desc" }, take,
      select: { id: true, content: true, createdAt: true, scheduledAt: true, creator: { select: { name: true } } },
    }).then((rows) => rows.map((r) => nextActionCreatedEvent(r, propertyId))));
    tasks.push(prisma.nextAction.findMany({
      where: { propertyId, completedAt: lt }, orderBy: { completedAt: "desc" }, take,
      select: { id: true, content: true, completedAt: true },
    }).then((rows) => rows.map((r) => nextActionCompletedEvent(r, propertyId))));
  }
  if (wants("investigation")) {
    tasks.push(prisma.propertyInvestigationAuditLog.findMany({
      where: { propertyId, createdAt: lt, action: { in: INVESTIGATION_ACTIONS } }, orderBy: { createdAt: "desc" }, take,
      select: { id: true, action: true, note: true, createdAt: true, creator: { select: { name: true } } },
    }).then((rows) => rows.map((r) => investigationEvent(r, propertyId))));
  }
  return (await Promise.all(tasks)).flat();
}

/** 取引の出どころ。 */
async function loadDealEvents(deals: TimelineDeal[], access: TimelineAccess, wants: (s: TimelineSource) => boolean, before: Date, take: number): Promise<TimelineEvent[]> {
  if (deals.length === 0) return [];
  const ids = deals.map((d) => d.id);
  const refs = new Map(deals.map((d) => [d.id, dealRef(d)]));
  const ref = (id: string) => refs.get(id) as DealRef;
  const lt = { lt: before };
  const tasks: Promise<TimelineEvent[]>[] = [];

  if (wants("deal_created")) {
    tasks.push(Promise.resolve(deals.filter((d) => d.createdAt < before).map((d) => dealCreatedEvent(d, ref(d.id)))));
  }
  if (wants("schedule")) {
    tasks.push(prisma.dealScheduleItem.findMany({
      where: { dealId: { in: ids }, completedAt: lt, excludedAt: null }, orderBy: { completedAt: "desc" }, take,
      select: { id: true, dealId: true, label: true, completedAt: true, autoCompleted: true },
    }).then((rows) => rows.map((r) => scheduleEvent(r, ref(r.dealId)))));
  }
  if (wants("document")) {
    tasks.push(prisma.dealDocument.findMany({
      where: { dealId: { in: ids }, issuedAt: lt }, orderBy: { issuedAt: "desc" }, take,
      select: { id: true, dealId: true, docType: true, variant: true, version: true, issuedAt: true, issuedBy: { select: { name: true } } },
    }).then((rows) => rows.map((r) => documentEvent(r, ref(r.dealId)))));
  }
  if (wants("request_copy")) {
    tasks.push((async () => {
      const [rows, settings] = await Promise.all([
        prisma.auditLog.findMany({
          where: { action: "deal_request_draft_copy", targetTable: "deals", targetId: { in: ids }, createdAt: lt }, orderBy: { createdAt: "desc" }, take,
          select: { id: true, targetId: true, createdAt: true, detail: true, user: { select: { name: true } } },
        }),
        loadDealSettings(),
      ]);
      return rows.flatMap((r) => (r.targetId && refs.has(r.targetId) ? [requestCopyEvent(r, ref(r.targetId), settings.requestTemplates)] : []));
    })());
  }
  if (wants("doc_file")) {
    tasks.push(prisma.dealDocFile.findMany({
      where: { request: { link: { dealId: { in: ids } } }, createdAt: lt }, orderBy: { createdAt: "desc" }, take,
      select: { id: true, createdAt: true, request: { select: { label: true, link: { select: { dealId: true, partyRole: true } } } } },
    }).then((rows) => rows.map((r) => docFileEvent(r, ref(r.request.link.dealId)))));
  }
  if (wants("doc_review")) {
    tasks.push(prisma.dealDocRequest.findMany({
      where: { link: { dealId: { in: ids } }, reviewedAt: lt, status: { in: ["received", "rejected"] } }, orderBy: { reviewedAt: "desc" }, take,
      select: { id: true, label: true, status: true, rejectReason: true, reviewedAt: true, reviewedBy: { select: { name: true } }, link: { select: { dealId: true } } },
    }).then((rows) => rows.map((r) => docReviewEvent(r, ref(r.link.dealId), access.dealManage))));
  }
  if (wants("doc_link")) {
    tasks.push(prisma.dealDocLink.findMany({
      where: { dealId: { in: ids }, OR: [{ createdAt: lt }, { revokedAt: lt }] }, orderBy: { createdAt: "desc" }, take,
      select: { id: true, dealId: true, partyRole: true, createdAt: true, revokedAt: true, createdBy: { select: { name: true } } },
    }).then((rows) => rows.flatMap((r) => docLinkEvents(r, ref(r.dealId))).filter((e) => new Date(e.at) < before)));
  }
  return (await Promise.all(tasks)).flat();
}

/** 変更履歴(物件・棟・つながり・取引)。 */
async function loadChangeEvents(scope: TimelineScope, deals: TimelineDeal[], access: TimelineAccess, wants: (s: TimelineSource) => boolean, before: Date): Promise<{ events: TimelineEvent[]; truncated: boolean }> {
  const targets: Record<string, unknown>[] = [];
  if (access.property && scope.propertyId && wants("change")) {
    targets.push({ targetTable: "properties", targetId: scope.propertyId });
    if (scope.buildingId) targets.push({ targetTable: "buildings", targetId: scope.buildingId });
  }
  if (access.ownerLinks && scope.propertyId && wants("owner_change")) {
    const links = await prisma.propertyOwner.findMany({ where: { propertyId: scope.propertyId }, select: { id: true } });
    if (links.length > 0) targets.push({ targetTable: "property_owners", targetId: { in: links.map((l) => l.id) } });
  }
  if (deals.length > 0 && wants("change")) targets.push({ targetTable: "deals", targetId: { in: deals.map((d) => d.id) } });
  if (targets.length === 0) return { events: [], truncated: false };

  const rows: ChangeRow[] = await prisma.changeLog.findMany({
    where: { OR: targets, changedAt: { lt: before } }, orderBy: { changedAt: "desc" }, take: CHANGE_TAKE,
    select: {
      id: true, targetTable: true, targetId: true, fieldName: true, oldValue: true, newValue: true, source: true, changedAt: true,
      changer: { select: { name: true } },
    },
  });
  const userIds = userIdsInChanges(rows);
  const users = userIds.length > 0 ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
  const reachedTake = rows.length >= CHANGE_TAKE;
  const { events } = changeEvents(rows, {
    propertyId: scope.propertyId,
    dealsById: new Map(deals.map((d) => [d.id, dealRef(d)])),
    userNames: new Map(users.map((u) => [u.id, u.name])),
    inquirerLevel: access.inquirerLevel,
    ownerNote: access.ownerNote,
  }, { reachedTake });
  return { events, truncated: reachedTake };
}

async function loadEvents(scope: TimelineScope, access: TimelineAccess, filter: TimelineFilter, before: Date, limit: number) {
  const wanted = new Set(sourcesForCategory(filter));
  const wants = (s: TimelineSource) => wanted.has(s);
  const deals = access.deal ? scope.deals : [];
  const take = limit + 1;
  const [propertyEvents, dealEvents, changes] = await Promise.all([
    access.property && scope.propertyId ? loadPropertyEvents(scope.propertyId, access, wants, before, take) : Promise.resolve([]),
    loadDealEvents(deals, access, wants, before, take),
    loadChangeEvents(scope, deals, access, wants, before),
  ]);
  return mergeTimeline([...propertyEvents, ...dealEvents, ...changes.events], limit, changes.truncated);
}

const isOpenDeal = (status: string) => status !== "cancelled" && status !== "settled";

/** 上部の「直近の状況」。⚠最後のやり取りも見える出どころだけから作る(隠れた行の日付を漏らさない)。 */
async function loadSummary(scope: TimelineScope, access: TimelineAccess, now: Date, viewedFrom: "property" | "deal"): Promise<TimelineSummary> {
  const deals = access.deal ? scope.deals : [];
  const openIds = deals.filter((d) => isOpenDeal(d.status)).map((d) => d.id);
  const statuses: TimelineSummary["statuses"] = [];
  for (const d of deals) {
    if (viewedFrom === "deal" || isOpenDeal(d.status)) {
      statuses.push({ label: viewedFrom === "deal" ? "取引の状態" : `取引 ${d.dealNo}`, value: (DEAL_STATUS_LABELS as Record<string, string>)[d.status] ?? d.status });
    }
  }
  if (access.property && scope.caseStatus) {
    statuses.push({ label: "案件ステータス", value: CASE_STATUS_LABELS[scope.caseStatus] ?? scope.caseStatus });
  }

  const [nextItem, nextAction, contact, pendingDocs] = await Promise.all([
    openIds.length > 0
      ? prisma.dealScheduleItem.findFirst({
          where: { dealId: { in: openIds }, completedAt: null, excludedAt: null, preIntroduction: false }, orderBy: { dueDate: "asc" },
          select: { label: true, dueDate: true },
        })
      : null,
    access.property && scope.propertyId
      ? prisma.nextAction.findFirst({
          where: { propertyId: scope.propertyId, isCompleted: false }, orderBy: { scheduledAt: "asc" },
          select: { content: true, scheduledAt: true },
        })
      : null,
    loadEvents(scope, access, "contact", now, 1),
    !access.deal
      ? null
      : openIds.length > 0
        ? prisma.dealDocRequest.count({ where: { status: { not: "received" }, link: { dealId: { in: openIds }, revokedAt: null } } })
        : 0,
  ]);
  const nextCandidates: NextCandidate[] = [
    ...(nextItem ? [{ label: nextItem.label, due: nextItem.dueDate.toISOString().slice(0, 10) }] : []),
    ...(nextAction ? [{ label: nextAction.content.slice(0, 60), due: nextAction.scheduledAt.toISOString().slice(0, 10) }] : []),
  ];
  return buildTimelineSummary({ statuses, nextCandidates, lastContactAt: contact.events[0]?.at ?? null, pendingDocs });
}

/**
 * 経緯の1ページ。続きの読み込み(before あり)では要約を作らない。
 * 所有者の情報を含む行を返したときだけ、件数を監査に残す(本文・氏名は残さない・発注者決定 2026-11-02)。
 */
export async function loadTimelinePage(args: {
  scope: TimelineScope; access: TimelineAccess; query: { category: TimelineFilter; before?: string };
  userId: string; viewedFrom: "property" | "deal"; now?: Date;
}) {
  const { scope, access, query, userId, viewedFrom } = args;
  const now = args.now ?? new Date();
  // 先の予定(これからの内見など)は経緯に入れない=「いま」より前だけ。
  const before = query.before ? new Date(query.before) : now;
  const [page, summary] = await Promise.all([
    loadEvents(scope, access, query.category, before, TIMELINE_PAGE_SIZE),
    query.before ? null : loadSummary(scope, access, now, viewedFrom),
  ]);
  const ownerRows = page.events.filter((e) => OWNER_INFO_SOURCES.has(e.source)).length;
  if (ownerRows > 0 && scope.propertyId) {
    await writeAuditLog({ userId, action: "history_timeline_view", targetTable: "properties", targetId: scope.propertyId, detail: { count: ownerRows } });
  }
  return { events: page.events, nextBefore: page.nextBefore, summary };
}
