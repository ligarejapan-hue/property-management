import type { DealListItem, DealPartyView, DealView } from "./view";
import type { DealSettingsView } from "./settings";
import type { PropertyKindDef } from "./constants";

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
export interface RateTableView { id: string; kind: string; validFrom: string; validTo: string | null; content: unknown }

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
};

export const errorText = (e: unknown) => (e instanceof Error ? e.message : "通信に失敗しました。もう一度お試しください。");
