import type { PropertyDealSummary } from "@/lib/property-business-type";
import type { DealListItem, DealPartyView, DealView } from "./view";
import type { DealSettingsView } from "./settings";
import type { PropertyKindDef } from "./constants";
import type { DealCalc } from "./calc/deal-calc";
import type { FundingPlanCalc } from "./calc/funding-plan";
import type { FundingInputs } from "./funding-schema";
import type { DealImageKind } from "./branding";
import type { BusinessInputs } from "./business-schema";
import type { BusinessPlanCalc } from "./calc/business-plan";
import type { BusinessSectionKey } from "./business-sections";
import type { RegistryRightsView } from "./registry-rights";
import type { CrosscheckResult } from "./crosscheck";
import type { ScheduleItemView } from "./schedule-sync";
import type { DocLinksResponse, DocProgress } from "./doc-links/staff-store";
import type { RequestDraftCopyView, RequestDraftResponse } from "./request-drafts/store";
import type { FormDef } from "@/lib/deals/documents/forms/types";
import type { DealParcelOption } from "./target-parcels";

/** 取引の画面から API を呼ぶ。失敗はサーバーの文言とコードを持った DealApiError にする。 */
export class DealApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function call<T>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const form = init?.body instanceof FormData;
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    // FormData はブラウザに区切り付きの Content-Type を付けさせる。
    headers: init?.body !== undefined && !form ? { "Content-Type": "application/json" } : undefined,
    body: init?.body === undefined ? undefined : form ? (init.body as FormData) : JSON.stringify(init.body),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new DealApiError(res.status, body?.error?.code ?? "ERROR", body?.error?.message ?? "通信に失敗しました。もう一度お試しください。");
  }
  return body as T;
}

export interface DealOptions {
  propertyKinds: PropertyKindDef[];
  selfParty: { name: string; representative: string | null; address: string | null; phone: string | null };
}
export interface UserOption { id: string; name: string; role: string }
export interface RateTableView { id: string; kind: string; validFrom: string; validTo: string | null; content: unknown; updatedAt: string }
/** 書類タブに出す業務書類と、出す前の確認(段5)。 */
export interface AvailableDocument {
  docType: string; label: string; group: "contract" | "settlement" | "other" | "oc" | "checklist"; missing: string[]; blocking: string[]; defaults: Record<string, unknown>;
  issuers: { value: string; label: string; individual: boolean }[] | null;
  /** 当事者などから選ぶ欄の選べる値(欄の名前ごと)。 */
  choices: Record<string, { value: string; label: string }[]> | null;
  /** 項目の表(入力欄を共通の部品で描く・第2段階 段B)。無い書類は null。 */
  form: FormDef | null;
  /** 前回の入力を分けて覚える欄(媒介契約書=依頼の内容・契約のご案内=宛先)。無い書類は null。 */
  rememberBy: string | null;
  /** その欄の値ごとの初めの値(切り替えたらこれに入れ替える・両手の取引の売主様用と買主様用・発注者決定 2026-10-29)。 */
  starts: Record<string, Record<string, unknown>> | null;
}
export interface DealDocumentView {
  id: string; docType: string; variant: string; version: number; title: string;
  issuedAt: string; issuedByName: string; fileBaseName: string; hasPdf: boolean; hasXlsx: boolean;
}

/** 同じ物件のほかの取引(買取再販の仕入・売却を行き来する)。 */
export type RelatedDeal = PropertyDealSummary & { price: number | null };
export interface DealDetailResponse {
  deal: DealView; canOpenProperty: boolean; canChangeStatus: boolean; canChangeAssignee: boolean; canMoveCaseStatus: boolean;
  relatedDeals: RelatedDeal[];
  /** この取引の土地・建物で選べるもの(空=選ぶ欄を出さない)。 */
  parcelOptions?: DealParcelOption[];
}

export const dealsApi = {
  list: (params: Record<string, string>) =>
    call<{ deals: DealListItem[]; total: number; page: number; pageSize: number }>(`/api/deals?${new URLSearchParams(params)}`),
  create: (body: Record<string, unknown>) => call<{ id: string; dealNo: string }>("/api/deals", { method: "POST", body }),
  get: (id: string) => call<DealDetailResponse>(`/api/deals/${id}`),
  /** 物件の謄本(全部事項)の登記の現況(確認用・段5c-2)。 */
  registryRights: (id: string) => call<{ rights: RegistryRightsView }>(`/api/deals/${id}/registry-rights`),
  /** 数値照合(確認用)。 */
  crosscheck: (id: string) => call<{ crosscheck: CrosscheckResult }>(`/api/deals/${id}/crosscheck`),
  update: (id: string, body: Record<string, unknown>) => call<{ version: number; caseStatusNotChanged?: boolean }>(`/api/deals/${id}`, { method: "PATCH", body }),
  /** 決済までの段取り。 */
  schedule: (id: string) => call<{ items: ScheduleItemView[]; today: string; settlementDate: string | null; docProgress: DocProgress[]; requestDraftCopies: RequestDraftCopyView[] }>(`/api/deals/${id}/schedule`),
  requestDraft: (id: string, itemId: string, q: { templateId?: string; recipientId?: string }) => {
    const qs = new URLSearchParams(q).toString();
    return call<RequestDraftResponse>(`/api/deals/${id}/schedule/${itemId}/request-draft${qs ? `?${qs}` : ""}`);
  },
  logRequestDraftCopy: (id: string, itemId: string, templateId: string) => call<{ ok: true }>(`/api/deals/${id}/schedule/${itemId}/request-draft`, { method: "POST", body: { templateId } }),
  addScheduleItem: (id: string, body: Record<string, unknown>) => call<{ id: string }>(`/api/deals/${id}/schedule`, { method: "POST", body }),
  updateScheduleItem: (id: string, itemId: string, body: Record<string, unknown>) => call<{ ok: true }>(`/api/deals/${id}/schedule/${itemId}`, { method: "PATCH", body }),
  docLinks: (id: string) => call<DocLinksResponse>(`/api/deals/${id}/doc-links`),
  issueDocLink: (id: string, body: { partyId: string; itemIds: string[]; days: number; rotate: boolean }) => call<{ ok: true }>(`/api/deals/${id}/doc-links`, { method: "POST", body }),
  revokeDocLink: (id: string, linkId: string) => call<{ ok: true }>(`/api/deals/${id}/doc-links/${linkId}/revoke`, { method: "POST" }),
  reviewDocRequest: (id: string, requestId: string, body: { action: "receive"; fileIds: string[] } | { action: "reject"; fileIds: string[]; reason: string }) =>
    call<{ ok: true }>(`/api/deals/${id}/doc-links/requests/${requestId}`, { method: "POST", body }),
  docFileUrl: (id: string, fileId: string) => `/api/deals/${id}/doc-links/files/${fileId}`,
  completePreScheduleItems: (id: string) => call<{ count: number }>(`/api/deals/${id}/schedule/complete-pre`, { method: "POST" }),
  /** この取引の土地・建物(null=全部)。 */
  saveTargetParcels: (id: string, version: number, targetParcels: string[] | null) =>
    call<{ version: number }>(`/api/deals/${id}/target-parcels`, { method: "POST", body: { version, targetParcels } }),
  refreshProperty: (id: string, version: number) =>
    call<{ version: number }>(`/api/deals/${id}/refresh-property`, { method: "POST", body: { version } }),
  /** ownerIds なし=売主がいない取引の全員。あり=選んだ人だけ。 */
  addSellersFromOwners: (id: string, ownerIds?: string[]) =>
    call<{ added: number }>(`/api/deals/${id}/parties/from-owners`, { method: "POST", body: ownerIds ? { ownerIds } : {} }),
  sellerCandidates: (id: string) =>
    call<{ hasSellers: boolean; candidates: { ownerId: string; name: string }[] }>(`/api/deals/${id}/parties/from-owners`),
  addParty: (id: string, body: Record<string, unknown>) =>
    call<{ party: DealPartyView }>(`/api/deals/${id}/parties`, { method: "POST", body }),
  updateParty: (id: string, partyId: string, body: Record<string, unknown>) =>
    call<{ version: number }>(`/api/deals/${id}/parties/${partyId}`, { method: "PATCH", body }),
  deleteParty: (id: string, partyId: string, version: number) =>
    call<{ ok: true }>(`/api/deals/${id}/parties/${partyId}?version=${version}`, { method: "DELETE" }),
  options: () => call<DealOptions>("/api/deals/options"),
  getSettings: () => call<{ settings: DealSettingsView }>("/api/admin/deal-settings"),
  saveSettings: (body: Record<string, unknown>) => call<{ settings: DealSettingsView }>("/api/admin/deal-settings", { method: "PUT", body }),
  rateTables: () => call<{ tables: RateTableView[] }>("/api/admin/deal-settings/rate-tables"),
  /** ロゴ・角印を登録する(差し替えも同じ)。version は取引の設定の版。 */
  uploadSettingsImage: (kind: DealImageKind, file: File, version: number) => {
    const body = new FormData();
    body.append("file", file);
    body.append("version", String(version));
    return call<{ settings: DealSettingsView }>(`/api/admin/deal-settings/images/${kind}`, { method: "POST", body });
  },
  deleteSettingsImage: (kind: DealImageKind, version: number) =>
    call<{ settings: DealSettingsView }>(`/api/admin/deal-settings/images/${kind}?version=${version}`, { method: "DELETE" }),
  users: () => call<{ data: UserOption[] }>("/api/users"),
  calc: (id: string) => call<{ calc: DealCalc }>(`/api/deals/${id}/calc`),
  fundingPreview: (id: string, fundingPlan: FundingInputs) =>
    call<{ calc: FundingPlanCalc; html: string }>(`/api/deals/${id}/funding-plan/preview`, { method: "POST", body: { fundingPlan } }),
  businessPreview: (id: string, businessPlan: BusinessInputs) =>
    call<{ calc: BusinessPlanCalc; sections: BusinessSectionKey[]; html: string }>(`/api/deals/${id}/business-plan/preview`, { method: "POST", body: { businessPlan } }),
  documents: (id: string) => call<{ documents: DealDocumentView[] }>(`/api/deals/${id}/documents`),
  issueDocument: (id: string, docType: string, version: number, options?: Record<string, unknown>) =>
    call<{ id: string; version: number; title: string; fileBaseName: string }>(`/api/deals/${id}/documents`, {
      method: "POST", body: options === undefined ? { docType, version } : { docType, version, options },
    }),
  availableDocuments: (id: string) => call<{ documents: AvailableDocument[]; version: number }>(`/api/deals/${id}/documents/available`),
  createRateTable: (body: Record<string, unknown>) => call<{ id: string }>("/api/admin/deal-settings/rate-tables", { method: "POST", body }),
  updateRateTable: (id: string, body: Record<string, unknown>) => call<{ ok: true }>(`/api/admin/deal-settings/rate-tables/${id}`, { method: "PUT", body }),
  deleteRateTable: (id: string, updatedAt: string) =>
    call<{ ok: true }>(`/api/admin/deal-settings/rate-tables/${id}?updatedAt=${encodeURIComponent(updatedAt)}`, { method: "DELETE" }),
};

/** 発行した書類のファイルを開く道(取引の権限で配る)。 */
export const dealDocumentFileUrl = (dealId: string, docId: string, format: "pdf" | "xlsx") =>
  `/api/deals/${dealId}/documents/${docId}/file?format=${format}`;

export const errorText = (e: unknown) => (e instanceof Error ? e.message : "通信に失敗しました。もう一度お試しください。");
