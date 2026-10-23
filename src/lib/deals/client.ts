import type { DealListItem, DealPartyView, DealView } from "./view";
import type { DealSettingsView } from "./settings";
import type { PropertyKindDef } from "./constants";
import type { DealCalc } from "./calc/deal-calc";
import type { FundingPlanCalc } from "./calc/funding-plan";
import type { FundingInputs } from "./funding-schema";

/** 取引の画面から API を呼ぶ。失敗はサーバーの文言とコードを持った DealApiError にする。 */
export class DealApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function call<T>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
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
export interface DealDocumentView {
  id: string; docType: string; variant: string; version: number; title: string;
  issuedAt: string; issuedByName: string; fileBaseName: string; hasPdf: boolean; hasXlsx: boolean;
}

export const dealsApi = {
  list: (params: Record<string, string>) =>
    call<{ deals: DealListItem[]; total: number; page: number; pageSize: number }>(`/api/deals?${new URLSearchParams(params)}`),
  create: (body: Record<string, unknown>) => call<{ id: string; dealNo: string }>("/api/deals", { method: "POST", body }),
  get: (id: string) => call<{ deal: DealView; canOpenProperty: boolean }>(`/api/deals/${id}`),
  update: (id: string, body: Record<string, unknown>) => call<{ version: number }>(`/api/deals/${id}`, { method: "PATCH", body }),
  refreshProperty: (id: string, version: number) =>
    call<{ version: number }>(`/api/deals/${id}/refresh-property`, { method: "POST", body: { version } }),
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
  users: () => call<{ data: UserOption[] }>("/api/users"),
  calc: (id: string) => call<{ calc: DealCalc }>(`/api/deals/${id}/calc`),
  fundingPreview: (id: string, fundingPlan: FundingInputs) =>
    call<{ calc: FundingPlanCalc; html: string }>(`/api/deals/${id}/funding-plan/preview`, { method: "POST", body: { fundingPlan } }),
  documents: (id: string) => call<{ documents: DealDocumentView[] }>(`/api/deals/${id}/documents`),
  issueDocument: (id: string, docType: string, version: number) =>
    call<{ id: string; version: number; title: string; fileBaseName: string }>(`/api/deals/${id}/documents`, { method: "POST", body: { docType, version } }),
  createRateTable: (body: Record<string, unknown>) => call<{ id: string }>("/api/admin/deal-settings/rate-tables", { method: "POST", body }),
  updateRateTable: (id: string, body: Record<string, unknown>) => call<{ ok: true }>(`/api/admin/deal-settings/rate-tables/${id}`, { method: "PUT", body }),
  deleteRateTable: (id: string, updatedAt: string) =>
    call<{ ok: true }>(`/api/admin/deal-settings/rate-tables/${id}?updatedAt=${encodeURIComponent(updatedAt)}`, { method: "DELETE" }),
};

/** 発行した書類のファイルを開く道(取引の権限で配る)。 */
export const dealDocumentFileUrl = (dealId: string, docId: string, format: "pdf" | "xlsx") =>
  `/api/deals/${dealId}/documents/${docId}/file?format=${format}`;

export const errorText = (e: unknown) => (e instanceof Error ? e.message : "通信に失敗しました。もう一度お試しください。");
