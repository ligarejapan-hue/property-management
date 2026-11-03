import { INQUIRY_KIND_LABELS } from "@/lib/agent-inquiry/constants";
import { DEAL_STATUS_LABELS } from "@/lib/deals/constants";
import { DOC_LINK_ROLE_LABELS } from "@/lib/deals/doc-links/constants";
import { dealDocumentTitle } from "@/lib/deals/documents/issue";
import { dmMethodLabel } from "@/lib/dm-method-labels";
import { REACTION_LABELS } from "@/lib/dm-reaction/core";
import { redactPropertyChangeValue } from "@/lib/inquirer-name";
import type { OwnerMemoBodyVisibility } from "@/lib/owner-memo";
import { isMaskFreeLevel, maskValue, type OwnerDisplayConfigShape } from "@/lib/permissions";
import { CHANGE_FIELD_LABELS, saleYenHistoryValue } from "@/lib/property-change-labels";
import { propertyDetailHref } from "@/lib/property-detail-tab";
import { CASE_STATUS_LABELS } from "@/lib/property-types";

/** 経緯の出どころ。owner_change=所有者とのつながりの変更履歴(change とは権限が違う)。 */
export type TimelineSource =
  | "comment" | "owner_memo" | "dm" | "dm_reaction" | "inquiry" | "viewing" | "material_send" | "request_copy"
  | "next_action" | "schedule"
  | "document" | "doc_file" | "doc_review" | "doc_link"
  | "change" | "owner_change" | "investigation" | "deal_created";

export const TIMELINE_CATEGORIES = ["contact", "document", "schedule", "change"] as const;
export type TimelineCategory = (typeof TIMELINE_CATEGORIES)[number];
export type TimelineFilter = TimelineCategory | "all";
export const TIMELINE_FILTER_LABELS: Record<TimelineFilter, string> = {
  all: "すべて", contact: "やり取り", document: "書類", schedule: "段取り", change: "データの変更",
};

const SOURCE_CATEGORY: Record<TimelineSource, TimelineCategory> = {
  comment: "contact", owner_memo: "contact", dm: "contact", dm_reaction: "contact", inquiry: "contact", viewing: "contact",
  material_send: "contact", request_copy: "contact",
  next_action: "schedule", schedule: "schedule",
  document: "document", doc_file: "document", doc_review: "document", doc_link: "document",
  change: "change", owner_change: "change", investigation: "change", deal_created: "change",
};

export const categoryOf = (source: TimelineSource): TimelineCategory => SOURCE_CATEGORY[source];

export function sourcesForCategory(filter: TimelineFilter): TimelineSource[] {
  const all = Object.keys(SOURCE_CATEGORY) as TimelineSource[];
  return filter === "all" ? all : all.filter((s) => SOURCE_CATEGORY[s] === filter);
}

/** 所有者の情報を含む行(開いたら件数と時刻を監査に残す)。 */
export const OWNER_INFO_SOURCES: ReadonlySet<TimelineSource> = new Set(["owner_memo", "dm", "dm_reaction", "owner_change"]);

export interface TimelineEvent {
  id: string;
  at: string;
  /** 日付だけの記録(時刻を出さない)。 */
  dateOnly: boolean;
  source: TimelineSource;
  category: TimelineCategory;
  /** 誰が。記録が無いときは null。 */
  actor: string | null;
  title: string;
  detail: string | null;
  href: string | null;
  /** 物件の経緯で、どの取引の行かを出す。 */
  dealLabel: string | null;
}

export interface DealRef { id: string; label: string }
type Named = { name: string };

function event(source: TimelineSource, id: string, at: Date, fields: Partial<Omit<TimelineEvent, "id" | "at" | "source" | "category">> & { title: string }): TimelineEvent {
  return {
    id: `${source}:${id}`, at: at.toISOString(), source, category: SOURCE_CATEGORY[source],
    dateOnly: false, actor: null, detail: null, href: null, dealLabel: null, ...fields,
  };
}
const dealFields = (deal: DealRef) => ({ href: `/deals/${deal.id}`, dealLabel: deal.label });

export function commentEvent(r: { id: string; body: string; createdAt: Date; author: Named; parentId: string | null }, propertyId: string) {
  return event("comment", r.id, r.createdAt, {
    title: r.parentId ? "コメントへの返信" : "コメント", actor: r.author.name, detail: r.body, href: propertyDetailHref(propertyId, "comments"),
  });
}

/** ⚠所有者の名前は出さない。本文は owner_note のレベルどおり(meta_only=空)。 */
export function ownerMemoEvent(r: { id: string; body: string; createdAt: Date; creator: Named }, visibility: OwnerMemoBodyVisibility, propertyId: string) {
  return event("owner_memo", r.id, r.createdAt, {
    title: "所有者メモ", actor: r.creator.name, detail: visibility === "visible" ? r.body : null, href: propertyDetailHref(propertyId, "owner"),
  });
}

export function dmSentEvent(r: { id: string; sentAt: Date; method: string | null; note: string | null; sender: Named }, noteLevel: string, propertyId: string) {
  return event("dm", r.id, r.sentAt, {
    title: r.method ? `DMを送付(${dmMethodLabel(r.method)})` : "DMを送付", dateOnly: true, actor: r.sender.name,
    detail: maskValue(r.note, noteLevel), href: `/properties/${propertyId}/dm-logs`,
  });
}

export function dmReactionEvent(r: { id: string; reactedAt: Date; reactionStatus: string; reactionNote: string | null }, noteLevel: string, propertyId: string) {
  const name = (REACTION_LABELS as Record<string, string>)[r.reactionStatus] ?? r.reactionStatus;
  return event("dm_reaction", r.id, r.reactedAt, {
    title: `DMの反響:${name}`, detail: maskValue(r.reactionNote, noteLevel), href: `/properties/${propertyId}/dm-logs`,
  });
}

export function inquiryEvent(r: { id: string; kind: string; receivedAt: Date; contactName: string | null; agent: { companyName: string }; createdBy: Named }, propertyId: string) {
  const kind = (INQUIRY_KIND_LABELS as Record<string, string>)[r.kind] ?? r.kind;
  return event("inquiry", r.id, r.receivedAt, {
    title: `反響を受付:${kind}(${r.agent.companyName})`, actor: r.createdBy.name,
    detail: r.contactName ? `担当者:${r.contactName}` : null, href: propertyDetailHref(propertyId, "inquiries"),
  });
}

export function viewingEvent(
  r: { id: string; scheduledAt: Date | null; createdAt: Date; canceledAt: Date | null; resultNote: string | null; attendant: Named | null; inquiry: { agent: { companyName: string } } },
  propertyId: string,
) {
  return event("viewing", r.id, r.scheduledAt ?? r.createdAt, {
    title: `${r.canceledAt ? "内見を中止" : "内見"}(${r.inquiry.agent.companyName})`, actor: r.attendant?.name ?? null,
    detail: r.resultNote, href: propertyDetailHref(propertyId, "inquiries"),
  });
}

/** ⚠宛先・件名・本文は読まない・出さない。 */
export function materialSendEvent(r: { id: string; createdAt: Date; result: string; sentBy: Named; inquiry: { agent: { companyName: string } } }, propertyId: string) {
  const failed = r.result === "failed";
  return event("material_send", r.id, r.createdAt, {
    title: `資料を送付${failed ? "(失敗)" : ""}(${r.inquiry.agent.companyName})`, actor: r.sentBy.name, href: propertyDetailHref(propertyId, "inquiries"),
  });
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export function nextActionCreatedEvent(r: { id: string; content: string; createdAt: Date; scheduledAt: Date; creator: Named }, propertyId: string) {
  return event("next_action", `${r.id}:created`, r.createdAt, {
    title: `次にやることを登録(期日 ${ymd(r.scheduledAt)})`, actor: r.creator.name, detail: r.content, href: propertyDetailHref(propertyId, "actions"),
  });
}

/** 完了にした人=監査ログから。見つからなければ出さない。 */
export function nextActionCompletedEvent(r: { id: string; content: string; completedAt: Date | null }, propertyId: string, actor: string | null = null) {
  return event("next_action", `${r.id}:completed`, r.completedAt as Date, {
    title: "次にやることを完了", actor, detail: r.content, href: propertyDetailHref(propertyId, "actions"),
  });
}

/** 操作の監査は保存のあとに書かれる。この幅に入る最初の記録をその操作とみなす。 */
const AUDIT_AFTER_MS = 60_000;

export interface AuditActor { createdAt: Date; user: Named | null }

/**
 * その時刻の操作をした人。見つからなければ null。
 * ⚠完了の時刻より前の記録は見ない(完了→取り消し→別の人が完了、で前の人を出さない・@codex P2)。
 * ⚠同じ項目をもう一度押した記録を拾わないよう、最初の1件だけ。
 */
export function actorOfAudit(at: Date, audits: readonly AuditActor[]): string | null {
  const from = at.getTime();
  const to = from + AUDIT_AFTER_MS;
  const inRange = audits.filter((a) => a.createdAt.getTime() >= from && a.createdAt.getTime() <= to);
  inRange.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return inRange[0]?.user?.name ?? null;
}

const INVESTIGATION_LABELS: Record<string, string> = {
  fetch_succeeded: "調査情報を取得", fetch_failed: "調査情報の取得に失敗", updated: "調査情報を更新", confirmed: "調査情報を確定",
};
/** 経緯に出す調査の記録(取得の依頼そのものは結果の行と重なるので出さない)。 */
export const INVESTIGATION_ACTIONS = Object.keys(INVESTIGATION_LABELS);

export function investigationEvent(r: { id: string; action: string; note: string | null; createdAt: Date; creator: Named }, propertyId: string) {
  return event("investigation", r.id, r.createdAt, {
    title: INVESTIGATION_LABELS[r.action] ?? r.action, actor: r.creator.name, detail: r.note, href: propertyDetailHref(propertyId, "investigation"),
  });
}

/** 段取りの完了。誰が=監査ログから(記録が無い過去の分は出さない)。 */
export function scheduleEvent(r: { id: string; label: string; completedAt: Date | null; autoCompleted: boolean }, deal: DealRef, actor: string | null = null) {
  return event("schedule", r.id, r.completedAt as Date, {
    title: `段取りを完了:${r.label}${r.autoCompleted ? "(自動)" : ""}`, actor: r.autoCompleted ? null : actor, ...dealFields(deal),
  });
}

export function scheduleUndoEvent(r: { id: string; createdAt: Date; user: Named | null }, label: string | null, deal: DealRef) {
  return event("schedule", `${r.id}:undo`, r.createdAt, {
    title: label ? `段取りの完了を取り消し:${label}` : "段取りの完了を取り消し", actor: r.user?.name ?? null, ...dealFields(deal),
  });
}

export function documentEvent(r: { id: string; docType: string; variant: string; version: number; issuedAt: Date; issuedBy: Named }, deal: DealRef) {
  return event("document", r.id, r.issuedAt, {
    title: `書類を発行:${dealDocumentTitle(r.docType, r.variant)} 第${r.version}版`, actor: r.issuedBy.name, ...dealFields(deal),
  });
}

export function requestCopyEvent(r: { id: string; createdAt: Date; detail: unknown; user: Named | null }, deal: DealRef, templates: readonly { id: string; label: string }[]) {
  const key = (r.detail as { templateKey?: unknown } | null)?.templateKey;
  const template = templates.find((t) => t.id === key);
  return event("request_copy", r.id, r.createdAt, {
    title: template ? `依頼文をコピー:${template.label}` : "依頼文をコピー", actor: r.user?.name ?? null, ...dealFields(deal),
  });
}

const roleLabel = (role: string) => (DOC_LINK_ROLE_LABELS as Record<string, string>)[role] ?? "お客様";

export function docFileEvent(r: { id: string; createdAt: Date; request: { label: string; link: { partyRole: string } } }, deal: DealRef) {
  return event("doc_file", r.id, r.createdAt, {
    title: `${roleLabel(r.request.link.partyRole)}が提出:${r.request.label}`, actor: "お客様", ...dealFields(deal),
  });
}

export function docReviewEvent(r: { id: string; action: string; reason: string | null; createdAt: Date; reviewedBy: Named | null; request: { label: string } }, deal: DealRef, canManage: boolean) {
  const rejected = r.action === "rejected";
  return event("doc_review", r.id, r.createdAt, {
    title: `${rejected ? "差し戻し" : "受領"}:${r.request.label}`, actor: r.reviewedBy?.name ?? null,
    detail: rejected && canManage ? r.reason : null, ...dealFields(deal),
  });
}

type DocLinkRow = { id: string; partyRole: string; createdAt: Date; revokedAt: Date | null; createdBy: Named };

export function docLinkIssuedEvent(r: DocLinkRow, deal: DealRef) {
  return event("doc_link", `${r.id}:issued`, r.createdAt, { title: `${roleLabel(r.partyRole)}の提出用リンクを発行`, actor: r.createdBy.name, ...dealFields(deal) });
}

export function docLinkRevokedEvent(r: DocLinkRow, deal: DealRef) {
  return event("doc_link", `${r.id}:revoked`, r.revokedAt as Date, { title: `${roleLabel(r.partyRole)}の提出用リンクを無効化`, ...dealFields(deal) });
}

export function dealCreatedEvent(r: { createdAt: Date; createdBy: Named }, deal: DealRef) {
  return event("deal_created", deal.id, r.createdAt, { title: "取引を作成", actor: r.createdBy.name, ...dealFields(deal) });
}

// ---------- 変更履歴 ----------

const DEAL_FIELD_LABELS: Record<string, string> = {
  businessType: "取引の種類", tradeSide: "売主側・買主側", status: "取引の状態", assigneeId: "担当者", licensedAgentId: "宅建士",
  salesStaffId: "営業担当", opsStaffId: "事務担当", propertyKind: "物件種別", hasOc: "OC", contractAt: "契約日", contractPlace: "契約場所",
  settlementAt: "決済日", settlementPlace: "決済場所", price: "売買価格", deposit: "手付金", taxRateBp: "消費税率",
};
const TABLE_LABELS: Record<string, string> = {
  properties: "物件の情報", buildings: "棟の情報", property_owners: "所有者とのつながり", deals: "取引の情報", owners: "所有者の情報",
};
/** 所有者本体の変更履歴に出す項目と、見せ方を決める表示レベル。⚠ここに無い項目は出さない。 */
const OWNER_CHANGE_FIELDS: Record<string, { label: string; level: keyof OwnerDisplayConfigShape }> = {
  name: { label: "氏名", level: "name" }, nameKana: { label: "フリガナ", level: "nameKana" }, phone: { label: "電話番号", level: "phone" },
  zip: { label: "登記上の郵便番号", level: "zip" }, address: { label: "登記上の住所", level: "address" },
  currentZip: { label: "現住所の郵便番号", level: "zip" }, currentAddress: { label: "現住所", level: "address" },
  note: { label: "備考", level: "note" }, email: { label: "メール", level: "email" },
  corporateNumber: { label: "法人番号", level: "corporateNumber" }, companyRegistryNumber: { label: "会社法人等番号", level: "corporateNumber" },
};
/** つながりを解除した印。⚠値は所有者の ID なので出さない。 */
const OWNER_UNLINK_FIELDS = new Set(["_unlinked_from_property", "_deleted_via_mislink_correction", "_deleted_via_merge"]);
/** 値が人の ID の項目(名前に直す)。それ以外の ID の値は出さない。 */
const USER_VALUE_FIELDS = new Set(["assignedTo", "assigneeId", "licensedAgentId", "salesStaffId", "opsStaffId"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const JST_DAY = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" });

export interface ChangeRow {
  id: string; targetTable: string; targetId: string; fieldName: string; oldValue: string | null; newValue: string | null;
  source: string; changedAt: Date; changer: Named;
}
export interface ChangeContext {
  propertyId: string | null;
  dealsById: ReadonlyMap<string, DealRef>;
  userNames: ReadonlyMap<string, string>;
  inquirerLevel: string | null;
  ownerNote: OwnerMemoBodyVisibility;
  ownerLevels: OwnerDisplayConfigShape;
}

/** 名前に直す人の ID(値は変更履歴に残っている)。 */
export function userIdsInChanges(rows: readonly ChangeRow[]): string[] {
  const ids = rows.flatMap((r) => (USER_VALUE_FIELDS.has(r.fieldName) ? [r.oldValue, r.newValue] : [])).filter((v): v is string => !!v && UUID.test(v));
  return [...new Set(ids)];
}

function fieldLabel(row: ChangeRow): string {
  if (row.targetTable === "deals") return DEAL_FIELD_LABELS[row.fieldName] ?? row.fieldName;
  if (row.targetTable === "owners") return OWNER_CHANGE_FIELDS[row.fieldName]?.label ?? row.fieldName;
  return CHANGE_FIELD_LABELS[row.fieldName] ?? row.fieldName;
}

function displayValue(row: ChangeRow, value: string | null, ctx: ChangeContext): string {
  if (value === null || value === "") return "(空)";
  if (UUID.test(value)) return (USER_VALUE_FIELDS.has(row.fieldName) && ctx.userNames.get(value)) || "(表示なし)";
  if (row.targetTable === "properties" && row.fieldName === "caseStatus") return CASE_STATUS_LABELS[value] ?? value;
  if (row.targetTable === "properties") {
    const yen = saleYenHistoryValue(row.fieldName, value);
    if (yen !== null) return yen;
  }
  if (row.targetTable === "deals" && row.fieldName === "status") return (DEAL_STATUS_LABELS as Record<string, string>)[value] ?? value;
  if (value === "true") return "はい";
  if (value === "false") return "いいえ";
  return ISO_DATE_TIME.test(value) && !Number.isNaN(Date.parse(value)) ? JST_DAY.format(new Date(value)) : value;
}

/** 元の画面と同じ伏せ方を当てる。null=その行を出さない。 */
function visibleRow(row: ChangeRow, ctx: ChangeContext): { row: ChangeRow; hideValues: boolean } | null {
  if (row.targetTable === "properties") {
    return {
      row: {
        ...row,
        oldValue: redactPropertyChangeValue(row.fieldName, row.oldValue, ctx.inquirerLevel),
        newValue: redactPropertyChangeValue(row.fieldName, row.newValue, ctx.inquirerLevel),
      },
      hideValues: false,
    };
  }
  // 所有者本体: 項目ごとの表示レベルで、そのまま見られる人にだけ値を出す。非表示なら行を出さない。
  if (row.targetTable === "owners") {
    const field = OWNER_CHANGE_FIELDS[row.fieldName];
    if (!field) return null;
    const level = ctx.ownerLevels[field.level];
    if (level === "hidden") return null;
    return isMaskFreeLevel(level) ? { row, hideValues: false } : { row: { ...row, oldValue: null, newValue: null }, hideValues: true };
  }
  // ⚠つながりの備考は自由記述の生値。経緯では owner_note のレベルでも絞る(発注者決定 2026-11-02)。
  if (row.targetTable === "property_owners" && row.fieldName === "note") {
    if (ctx.ownerNote === "hidden") return null;
    if (ctx.ownerNote === "meta_only") return { row: { ...row, oldValue: null, newValue: null }, hideValues: true };
  }
  return { row, hideValues: false };
}

/**
 * 同じ時刻・同じ人・同じ行の変更を1行にまとめる(取込で数十項目が一度に変わるため)。
 * ⚠rows は changedAt の新しい順。同じ時刻の行は全部読んである前提(load.ts の readWithTies)。
 */
export function changeEvents(rows: readonly ChangeRow[], ctx: ChangeContext): { events: TimelineEvent[] } {
  const groups = new Map<string, ChangeRow[]>();
  for (const row of rows) {
    const key = [row.targetTable, row.targetId, row.changer.name, row.source, row.changedAt.getTime()].join("|");
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  const events: TimelineEvent[] = [];
  const ownerTabHref = ctx.propertyId ? propertyDetailHref(ctx.propertyId, "owner") : null;
  for (const group of groups.values()) {
    const unlink = group.find((r) => OWNER_UNLINK_FIELDS.has(r.fieldName));
    if (unlink) {
      events.push(event("owner_change", unlink.id, unlink.changedAt, { title: "所有者の紐づけを解除", actor: unlink.changer.name, href: ownerTabHref }));
      continue;
    }
    const visible = group.flatMap((r) => visibleRow(r, ctx) ?? []);
    if (visible.length === 0) continue;
    const first = visible[0].row;
    const labels = visible.map((v) => fieldLabel(v.row));
    const change = (v: (typeof visible)[number]) => (v.hideValues ? null : `${displayValue(v.row, v.row.oldValue, ctx)} → ${displayValue(v.row, v.row.newValue, ctx)}`);
    const single = visible.length === 1;
    const table = TABLE_LABELS[first.targetTable] ?? first.targetTable;
    const shown = labels.length > 3 ? `${labels.slice(0, 3).join("・")} ほか${labels.length - 3}項目` : labels.join("・");
    const detail = single
      ? change(visible[0])
      : visible.map((v, i) => { const c = change(v); return c ? `${labels[i]}:${c}` : labels[i]; }).join("\n");
    const deal = first.targetTable === "deals" ? ctx.dealsById.get(first.targetId) : undefined;
    const ofOwner = first.targetTable === "owners";
    events.push(event(first.targetTable === "property_owners" || ofOwner ? "owner_change" : "change", first.id, first.changedAt, {
      title: single ? `${ofOwner ? "所有者の" : ""}${labels[0]}を変更` : `${table}を変更(${shown})`,
      // 自動の切り替えは、記録上の人が手で変えたように見せない(変更履歴タブと同じ)。
      actor: first.source === "auto" ? "自動" : first.changer.name, detail,
      ...(deal ? dealFields(deal) : { href: ofOwner ? ownerTabHref : ctx.propertyId ? propertyDetailHref(ctx.propertyId, "history") : null }),
    }));
  }
  return { events };
}

// ---------- 並べる ----------

/**
 * 新しい順に並べて上限で切る。同じ時刻の行は境目で分けない(続きは「その時刻より前」で読むため)。
 * floor=ここまでしか読み切っていない出どころの時刻。それより古い行はこのページに出さない
 * (先へ進むと、読んでいない行を「その時刻より前」の読み込みが飛ばしてしまう・@codex P2)。
 * more=読む上限に届いた出どころがある(同じ時刻の行で全部を出し切っても、もっと古い行が残っている・@codex P2)。
 */
export function mergeTimeline(
  events: readonly TimelineEvent[], limit: number, opts: { floor?: string | null; more?: boolean } = {},
): { events: TimelineEvent[]; nextBefore: string | null } {
  const floor = opts.floor ?? null;
  const sorted = events
    .filter((e) => floor === null || e.at >= floor)
    .sort((a, b) => (a.at === b.at ? a.id.localeCompare(b.id) : a.at < b.at ? 1 : -1));
  let end = Math.min(limit, sorted.length);
  while (end > 0 && end < sorted.length && sorted[end].at === sorted[end - 1].at) end += 1;
  const page = sorted.slice(0, end);
  if (end < sorted.length) return { events: page, nextBefore: page[page.length - 1].at };
  // このページで出し切った。floor があれば、その時刻より前に続きがある。
  const last = page.length > 0 ? page[page.length - 1].at : null;
  return { events: page, nextBefore: floor ?? (opts.more ? last : null) };
}

// ---------- 直近の状況 ----------

export interface NextCandidate { label: string; due: string }
export interface TimelineSummary {
  statuses: { label: string; value: string }[];
  next: NextCandidate | null;
  lastContactAt: string | null;
  /** 未受領の書類の件数。null=取引を見られない(出さない)。 */
  pendingDocs: number | null;
  /** 次の段取りが無いときに残っている導入前の未完了の件数(次の段取りに数えない分)。次の段取りがあれば 0。 */
  preIntroPending: number;
}

export function buildTimelineSummary(input: {
  statuses: { label: string; value: string }[];
  nextCandidates: NextCandidate[];
  lastContactAt: string | null;
  pendingDocs: number | null;
  preIntroPending?: number;
}): TimelineSummary {
  const [next] = [...input.nextCandidates].sort((a, b) => a.due.localeCompare(b.due));
  return {
    statuses: input.statuses, next: next ?? null, lastContactAt: input.lastContactAt, pendingDocs: input.pendingDocs,
    preIntroPending: next ? 0 : (input.preIntroPending ?? 0),
  };
}
