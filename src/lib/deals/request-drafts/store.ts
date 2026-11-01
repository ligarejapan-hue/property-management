import prisma from "@/lib/prisma";
import type { PermissionEntry } from "@/lib/api-helpers";
import { hasPermission, isMaskFreeLevel, resolveOwnerDisplayConfig } from "@/lib/permissions";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { resolveCompanyProfile } from "@/lib/sales-sheet/company-profile-store";
import { computeDealCalc } from "../calc/deal-calc";
import { itemsFor } from "../checklist";
import { kindBaseOf } from "../constants";
import { jstDateString } from "../datetime";
import { docLinkExpiresOn, docLinkStateOf, isDealOpenForDocs } from "../doc-links/constants";
import { docLinkAccess, docLinkBaseUrl } from "../doc-links/staff-store";
import { buildDocLinkToken, buildSubmitUrl, docLinkKey } from "../doc-links/token";
import { loadDealSettings } from "../settings-store";
import type { DealSettingsView } from "../settings";
import { DEAL_DETAIL_SELECT, toDealView } from "../view";
import { REQUEST_RECIPIENTS, renderRequestDraft, templatesForItem, type RequestBlank, type RequestTemplate } from "./templates";
import { buildRequestFieldValues, recipientOptions, recipientTarget, type RequestAccess, type RequestRecipientOption } from "./values";

export type DraftFailure = "item_not_found" | "no_template" | "bad_template" | "bad_recipient" | "deal_not_found";

export interface RequestDraftResponse {
  templates: { id: string; label: string }[];
  templateId: string;
  /** 相手の呼び名(司法書士など)。 */
  recipientLabel: string;
  recipients: RequestRecipientOption[];
  recipientId: string | null;
  text: string;
  blanks: RequestBlank[];
}

export interface RequestDraftCopyView { at: string; userName: string | null; templateLabel: string }

/** 所有者情報の表示レベルで、そのまま見られる人だけ(発注者決定 2026-11-02)。一部表示の人には差し込まない。 */
export function requestAccessOf(perms: PermissionEntry[]): Pick<RequestAccess, "name" | "address" | "canManage"> {
  const canReadOwner = hasPermission(perms, "owner", "read");
  const levels = resolveOwnerDisplayConfig(perms);
  return {
    name: canReadOwner && isMaskFreeLevel(levels.name),
    address: canReadOwner && isMaskFreeLevel(levels.address),
    canManage: docLinkAccess(perms).canManage,
  };
}

type DraftTarget = { item: { templateKey: string | null; assigneeId: string | null }; settings: DealSettingsView; linked: RequestTemplate[]; template: RequestTemplate };

/** 段取りの項目と、結びついたひな形を確かめる。templateId=null は結びついた最初のひな形。 */
export async function findDraftTarget(dealId: string, itemId: string, templateId: string | null): Promise<DraftTarget | { failure: DraftFailure }> {
  const item = await prisma.dealScheduleItem.findFirst({ where: { id: itemId, dealId }, select: { templateKey: true, assigneeId: true } });
  if (!item) return { failure: "item_not_found" };
  const settings = await loadDealSettings();
  const linked = templatesForItem(settings.requestTemplates, item.templateKey);
  if (!linked.length) return { failure: "no_template" };
  const template = templateId === null ? linked[0] : linked.find((t) => t.id === templateId);
  if (!template) return { failure: "bad_template" };
  return { item, settings, linked, template };
}

export async function loadRequestDraft(o: {
  dealId: string; itemId: string; templateId: string | null; recipientId: string | null;
  session: Parameters<typeof canAccessPropertyRecord>[0]; perms: PermissionEntry[]; now: Date;
}): Promise<RequestDraftResponse | { failure: DraftFailure }> {
  const target = await findDraftTarget(o.dealId, o.itemId, o.templateId);
  if ("failure" in target) return target;
  const { item, settings, linked, template } = target;
  const row = await prisma.deal.findUnique({ where: { id: o.dealId }, select: DEAL_DETAIL_SELECT });
  if (!row) return { failure: "deal_not_found" };
  const deal = toDealView(row);
  const access = requestAccessOf(o.perms);

  // 人ごとに作る相手は宛先を1人に決める(指定が無ければ最初の人)。
  const recipients = recipientOptions(template.recipient, deal, access.name);
  const recipientId = o.recipientId ?? recipients[0]?.id ?? null;
  const recipient = recipientId === null ? null : recipientTarget(template.recipient, deal, recipientId);
  if (recipientId !== null && !recipient) return { failure: "bad_recipient" };

  const [rateRows, companyRow, property, assignee] = await Promise.all([
    prisma.dealRateTable.findMany(),
    prisma.companyProfile.findUnique({ where: { id: "singleton" } }),
    deal.propertyId
      ? prisma.property.findUnique({ where: { id: deal.propertyId }, select: { createdBy: true, assignedTo: true, building: { select: { managementCompany: true } } } })
      : null,
    item.assigneeId || deal.assigneeId
      ? prisma.user.findUnique({ where: { id: (item.assigneeId ?? deal.assigneeId) as string }, select: { name: true } })
      : null,
  ]);
  const canOpenProperty = !!property && hasPermission(o.perms, "property", "read") && canAccessPropertyRecord(o.session, property);

  let docLink: { url: string; expiresOn: string } | null = null;
  // お客様が開けるリンクだけ(中止・決済済の取引では提出できない)。
  if (access.canManage && recipient?.kind === "seller" && isDealOpenForDocs(deal.status)) {
    const [link, baseUrl] = await Promise.all([
      prisma.dealDocLink.findFirst({ where: { dealId: o.dealId, partyId: recipient.party.id }, select: { publicId: true, expiresAt: true, revokedAt: true, partyRole: true, party: { select: { isSelf: true, role: true } } } }),
      docLinkBaseUrl(),
    ]);
    const key = docLinkKey();
    if (link && key && baseUrl && docLinkStateOf(link, o.now) === "active") {
      docLink = { url: buildSubmitUrl(baseUrl, buildDocLinkToken(link.publicId, key)), expiresOn: docLinkExpiresOn(link.expiresAt) };
    }
  }

  const values = buildRequestFieldValues({
    deal, recipient, docLink,
    settlement: computeDealCalc(deal, rateRows, settings.propertyKinds, jstDateString(o.now)).settlement,
    company: resolveCompanyProfile(companyRow),
    bankAccount: settings.bankAccount,
    access: { ...access, canOpenProperty },
    assigneeName: assignee?.name ?? null,
    buildingManagementCompany: property?.building?.managementCompany ?? null,
    documents: itemsFor(settings.checklistItems, "settlement", { base: kindBaseOf(settings, deal.propertyKind), hasOc: deal.hasOc })
      .filter((i) => i.group === "bring" && i.amount === null).map((i) => i.label),
  });
  return {
    templates: linked.map((t) => ({ id: t.id, label: t.label })),
    templateId: template.id,
    recipientLabel: REQUEST_RECIPIENTS[template.recipient],
    recipients, recipientId,
    ...renderRequestDraft(template.body, values),
  };
}

const COPY_HISTORY_LIMIT = 20;

/** 取引の履歴に出すコピーの記録(新しい順)。ひな形の名前は今の設定から引く(監査には鍵だけを残す)。読めなくても段取りは出す。 */
export async function loadRequestDraftCopies(dealId: string, templates: readonly RequestTemplate[]): Promise<RequestDraftCopyView[]> {
  try {
    const rows = await prisma.auditLog.findMany({
      where: { action: "deal_request_draft_copy", targetTable: "deals", targetId: dealId },
      orderBy: { createdAt: "desc" }, take: COPY_HISTORY_LIMIT,
      select: { createdAt: true, detail: true, user: { select: { name: true } } },
    });
    return rows.map((r) => {
      const key = (r.detail as { templateKey?: unknown } | null)?.templateKey;
      return { at: r.createdAt.toISOString(), userName: r.user?.name ?? null, templateLabel: templates.find((t) => t.id === key)?.label ?? "(消したひな形)" };
    });
  } catch {
    console.warn("deal_request_draft_copies_failed");
    return [];
  }
}
