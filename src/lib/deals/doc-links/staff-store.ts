import prisma from "@/lib/prisma";
import type { PermissionEntry } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { resolveCompanyProfile } from "@/lib/sales-sheet/company-profile-store";
import { loadSaleDmPublicPageConfig } from "@/lib/sale-dm-letter/config-store";
import { canOpenReferralDocument } from "@/lib/uploads-authorization";
import { itemsFor, type ChecklistItem } from "@/lib/deals/checklist";
import { loadDealSettings } from "@/lib/deals/settings-store";
import { kindBaseOf } from "@/lib/deals/constants";
import {
  DOC_LINK_ROLES, DOC_REQUEST_STATUSES, docLinkExpiresOn, docLinkStateOf, isDealOpenForDocs,
  receivedChecklistItemIds, type DocFileReviewState, type DocLinkRole, type DocLinkState, type DocRequestStatus,
} from "./constants";
import { buildDocLinkGuidance, buildMissingDocsText } from "./guidance";
import { buildDocLinkToken, buildSubmitUrl, docLinkKey } from "./token";

/** 発行できる項目 = 決済時の「持参するもの」「受け取るもの」。金額付きと、謄本から足す項目(担保の有無が伝わる)は入れない。 */
export function docLinkOptions(items: ChecklistItem[], deal: Parameters<typeof itemsFor>[2]): { id: string; label: string }[] {
  return itemsFor(items, "settlement", deal)
    .filter((i) => (i.group === "bring" || i.group === "receive") && i.amount === null)
    .map((i) => ({ id: i.id, label: i.label }));
}

/** リンクの操作は取引を編集できる人。ファイルを開く・受領・差し戻しは、所有者情報をすべて見られる人に絞る(発注者決定 2026-11-01)。 */
export function docLinkAccess(perms: PermissionEntry[]): { canManage: boolean; canReview: boolean } {
  const canManage = hasPermission(perms, "deal", "write");
  return { canManage, canReview: canManage && canOpenReferralDocument(perms) };
}

export interface DocLinkFileView { id: string; mimeType: string; fileSize: number; reviewState: DocFileReviewState; createdAt: string }
export interface DocLinkRequestView {
  id: string; checklistItemId: string; label: string; status: DocRequestStatus; rejectReason: string | null;
  fileCount: number; files: DocLinkFileView[];
}
export interface DocLinkView {
  id: string; partyId: string | null; partyRole: DocLinkRole; partyName: string | null; state: DocLinkState; expiresOn: string;
  url: string | null; guidance: string | null; missingText: string | null; requests: DocLinkRequestView[];
}
export interface DocLinksResponse {
  links: DocLinkView[];
  parties: { id: string; role: DocLinkRole; name: string }[];
  options: { id: string; label: string }[];
  canManage: boolean;
  canReview: boolean;
  /** 署名の鍵と公開の URL がそろっている(無ければ発行できない)。 */
  available: boolean;
  dealOpen: boolean;
}

const isRole = (r: string): r is DocLinkRole => (DOC_LINK_ROLES as readonly string[]).includes(r);
const statusOf = (s: string): DocRequestStatus => ((DOC_REQUEST_STATUSES as readonly string[]).includes(s) ? (s as DocRequestStatus) : "pending");

/** 公開の URL の土台(広告用ページ・追跡リンクと同じ設定)。画面の開き元(社内の入口)を使わない。 */
export async function docLinkBaseUrl(): Promise<string | null> {
  return (await loadSaleDmPublicPageConfig()).trackingBaseUrl ?? null;
}

export async function loadDocLinksView(dealId: string, perms: PermissionEntry[], now: Date): Promise<DocLinksResponse | null> {
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    select: { status: true, propertyKind: true, hasOc: true, parties: { select: { id: true, role: true, name: true, isSelf: true }, orderBy: { sortOrder: "asc" } } },
  });
  if (!deal) return null;
  const { canManage, canReview } = docLinkAccess(perms);
  const [settings, rows, baseUrl, companyRow] = await Promise.all([
    loadDealSettings(),
    prisma.dealDocLink.findMany({
      where: { dealId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true, partyId: true, partyRole: true, publicId: true, expiresAt: true, revokedAt: true, party: { select: { name: true } },
        requests: {
          orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
          select: {
            id: true, checklistItemId: true, label: true, status: true, rejectReason: true,
            files: { orderBy: { createdAt: "asc" }, select: { id: true, mimeType: true, fileSize: true, reviewState: true, createdAt: true } },
          },
        },
      },
    }),
    docLinkBaseUrl(),
    prisma.companyProfile.findUnique({ where: { id: "singleton" } }),
  ]);
  const key = docLinkKey();
  const companyName = resolveCompanyProfile(companyRow).nameJa;
  const links: DocLinkView[] = rows.map((l) => {
    const state = docLinkStateOf(l, now);
    const requests: DocLinkRequestView[] = l.requests.map((r) => ({
      id: r.id, checklistItemId: r.checklistItemId, label: r.label, status: statusOf(r.status), rejectReason: r.rejectReason,
      fileCount: r.files.length,
      // ファイルの一覧(開く入口)は、開ける人にだけ返す。
      files: canReview ? r.files.map((f) => ({ id: f.id, mimeType: f.mimeType, fileSize: f.fileSize, reviewState: f.reviewState as DocFileReviewState, createdAt: f.createdAt.toISOString() })) : [],
    }));
    // ⚠URL はリンクを扱える人にだけ渡す(持っていれば提出できる)。
    const url = canManage && key && baseUrl && state === "active" ? buildSubmitUrl(baseUrl, buildDocLinkToken(l.publicId, key)) : null;
    const expiresOn = docLinkExpiresOn(l.expiresAt);
    return {
      id: l.id, partyId: l.partyId, partyRole: isRole(l.partyRole) ? l.partyRole : "seller", partyName: l.party?.name ?? null, state, expiresOn, url, requests,
      missingText: canManage ? buildMissingDocsText(requests) : null,
      guidance: url ? buildDocLinkGuidance({ partyName: l.party?.name ?? null, companyName, url, expiresOn, requests }) : null,
    };
  });
  const base = kindBaseOf(settings, deal.propertyKind);
  return {
    links, canManage, canReview,
    parties: deal.parties.filter((p) => isRole(p.role) && !p.isSelf).map((p) => ({ id: p.id, role: p.role as DocLinkRole, name: p.name })),
    options: docLinkOptions(settings.checklistItems, { base, hasOc: deal.hasOc }),
    available: !!key && !!baseUrl,
    dealOpen: isDealOpenForDocs(deal.status),
  };
}

export interface DocProgress { partyRole: DocLinkRole; partyName: string | null; total: number; received: number }

/** 段取りの画面に出す受領の進み具合。 */
export async function loadDocProgress(dealId: string): Promise<DocProgress[]> {
  const rows = await prisma.dealDocLink.findMany({
    where: { dealId, partyId: { not: null } },
    orderBy: { createdAt: "asc" },
    select: { partyRole: true, party: { select: { name: true } }, requests: { select: { status: true } } },
  });
  return rows.filter((l) => l.requests.length > 0).map((l) => ({
    partyRole: isRole(l.partyRole) ? l.partyRole : "seller", partyName: l.party?.name ?? null,
    total: l.requests.length, received: l.requests.filter((r) => r.status === "received").length,
  }));
}

/** 書類確認書に ✓ を付ける項目。消した当事者のリンクの依頼は数えない。 */
export async function loadReceivedChecklistItemIds(dealId: string): Promise<Set<string>> {
  const rows = await prisma.dealDocRequest.findMany({
    where: { link: { dealId, partyId: { not: null } } }, select: { checklistItemId: true, status: true },
  });
  return receivedChecklistItemIds(rows);
}
