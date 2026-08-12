/**
 * API client with mock/real switching.
 *
 * When NEXT_PUBLIC_USE_MOCK is "true", returns mock data directly.
 * When false, calls the real API endpoints.
 *
 * To switch to real API: set NEXT_PUBLIC_USE_MOCK="" in .env and restart.
 */

import {
  MOCK_PROPERTIES,
  MOCK_COMMENTS,
  MOCK_NEXT_ACTIONS,
  MOCK_ATTACHMENTS,
  MOCK_CHANGE_LOGS,
  MOCK_CANDIDATES,
  MOCK_QUALITY_ISSUES,
  MOCK_IMPORT_JOBS,
  MOCK_USERS,
  MOCK_AUDIT_LOGS,
  MOCK_PHOTOS,
  MOCK_INVESTIGATION_RESULTS,
} from "./mock-data";
// 候補の型のみ取得する type-only import（runtime には何も import されない＝
// server 専用の provider/orchestrator や住所補完の APIキー(secret env) は client bundle に入らない）。
import type { AddressLookupCandidate } from "./address-lookup/types";
// 法人番号 lookup の候補型のみ取得する type-only import（runtime import なし＝
// server 専用 orchestrator や NTA の appId(secret env) は client bundle に入らない）。
import type { CorporateLookupRecord } from "./corporate-lookup/types";
// DM控えの冪等キー採番(本番はHTTPのため crypto.randomUUID は使えない)。
import { safeRandomId } from "./random-id";

export const USE_MOCK = process.env.NEXT_PUBLIC_USE_MOCK === "true";

// Small delay to simulate network latency
const mockDelay = () => new Promise((r) => setTimeout(r, 200));

// ---------- Generic fetcher ----------

/**
 * 非 2xx 応答を Error にする（分類コード付き）。
 *
 * ⚠**分類コードを画面まで届ける**(@codex #357 P2)。文言だけだと画面側は
 * 「利用者が自分で中止した」と「本当に失敗した」を区別できず、押した本人の
 * 操作まで赤いエラーとして出てしまう。追加のプロパティなので、既存の
 * `instanceof Error` / `e.message` を見ている呼び出し元はそのまま動く。
 */
async function toApiError(res: Response): Promise<Error> {
  const body = await res.json().catch(() => null);
  const err = new Error(body?.error?.message ?? `Error: ${res.status}`);
  return Object.assign(err, {
    code: typeof body?.error?.code === "string" ? body.error.code : null,
    status: res.status,
  });
}

/** 応答エラーから分類コードを取り出す（型を絞る補助）。 */
export function apiErrorCode(e: unknown): string | null {
  if (!(e instanceof Error)) return null;
  const code = (e as Error & { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw await toApiError(res);
  return res.json();
}

// ---------- Properties ----------

export async function fetchProperties(params: Record<string, string> = {}) {
  if (USE_MOCK) {
    await mockDelay();
    let filtered = [...MOCK_PROPERTIES];

    if (params.keyword) {
      const kw = params.keyword.toLowerCase();
      filtered = filtered.filter(
        (p) =>
          p.address.toLowerCase().includes(kw) ||
          p.lotNumber?.toLowerCase().includes(kw) ||
          p.realEstateNumber?.toLowerCase().includes(kw),
      );
    }
    if (params.propertyType) {
      filtered = filtered.filter((p) => p.propertyType === params.propertyType);
    }
    if (params.registryStatus) {
      filtered = filtered.filter((p) => p.registryStatus === params.registryStatus);
    }
    if (params.dmStatus) {
      filtered = filtered.filter((p) => p.dmStatus === params.dmStatus);
    }

    return {
      data: filtered,
      pagination: { page: 1, limit: 50, total: filtered.length, totalPages: 1 },
    };
  }

  const qs = new URLSearchParams(params).toString();
  return apiFetch<{ data: typeof MOCK_PROPERTIES; pagination: unknown }>(
    `/api/properties?${qs}`,
  );
}

/**
 * GET /api/properties/[id] の building 部分（id/name に加え、売マンション作成
 * ダイアログの自動反映プレビュー/ヒントが読む列を含む・@codex P2 fix）。
 * MOCK_PROPERTIES は building を持たない（mansion 種別の mock 未整備）ため、
 * 実レスポンス型は MOCK_PROPERTIES の形に building を追加で交差させる。
 */
export interface PropertyDetailBuildingSummary {
  id: string;
  name: string;
  structureType: string | null;
  totalFloors: number | null;
  totalUnits: number | null;
  managementCompany: string | null;
  builtYear: number | null;
}

export type PropertyDetailResult = (typeof MOCK_PROPERTIES)[0] & {
  building?: PropertyDetailBuildingSummary | null;
};

export async function fetchPropertyDetail(id: string): Promise<PropertyDetailResult> {
  if (USE_MOCK) {
    await mockDelay();
    const property = MOCK_PROPERTIES.find((p) => p.id === id);
    if (!property) throw new Error("物件が見つかりません");
    return property;
  }
  return apiFetch<PropertyDetailResult>(`/api/properties/${id}`);
}

export async function deleteProperty(id: string) {
  if (USE_MOCK) {
    await mockDelay();
    return { id, deleted: true };
  }
  return apiFetch<{ id: string; deleted: true }>(`/api/properties/${id}`, {
    method: "DELETE",
  });
}

// ---------- Comments ----------

export async function fetchComments(propertyId: string) {
  if (USE_MOCK) {
    await mockDelay();
    return { data: MOCK_COMMENTS };
  }
  return apiFetch<{ data: typeof MOCK_COMMENTS }>(
    `/api/properties/${propertyId}/comments`,
  );
}

export async function postComment(
  propertyId: string,
  body: string,
  parentId?: string | null,
) {
  if (USE_MOCK) {
    await mockDelay();
    return {
      id: "c-new-" + Date.now(),
      body,
      authorId: "u1",
      createdAt: new Date().toISOString(),
      author: { id: "u1", name: "田中太郎" },
    };
  }
  return apiFetch(`/api/properties/${propertyId}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body, parentId: parentId ?? null }),
  });
}

// ---------- Sale DM (売却促進DM) ----------

export interface CreateSaleDmCampaignBody {
  name: string;
  // 差出人(senderName/senderContact)は送らない。route が env 既定で補完する。
  options: {
    designTemplate: string;
    tone: string;
    length: string;
    appeal: string;
    strength: string;
    extraInstruction?: string;
  };
  filters?: Record<string, string>;
  // チェックで選んだ物件から作成する(指定時は filters より優先=対象=選択物件)。
  propertyIds?: string[];
  confirmed: boolean; // 課金確認(AI生成は有料+オーナーPII外部送信)。UI は確認後 true を送る。
  // 二重作成(再送信/別タブ/連打)防止の冪等性キー。作成試行ごとに安定生成し、成功で更新する。
  idempotencyKey?: string;
}

export async function createSaleDmCampaign(body: CreateSaleDmCampaignBody) {
  if (USE_MOCK) {
    await mockDelay();
    return { campaignId: "mock-campaign", requested: 0, matchedProperties: 0, generated: 0, saved: 0, skippedByUnlink: 0, failed: 0, truncated: false };
  }
  return apiFetch<{ campaignId: string; requested?: number; matchedProperties?: number; generated?: number; saved?: number; skippedByUnlink?: number; failed?: number; truncated?: boolean; idempotent?: boolean }>(
    "/api/properties/sale-dm/campaigns",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

export interface SaleDmDraft {
  id: string;
  variantId: string;
  propertyId: string;
  recipientName: string;
  recipientZip: string | null;
  recipientAddress: string | null;
  honorific: string;
  coOwnerCount: number; // 同送付先の共有者数(>1 で宛名に「他共有者様」を付す)
  body: string;
  status: string;
  outcome: string;
  deliveryStatus: string;
  lpFirstAccessAt: string | null;
  phoneInquiryAt: string | null;
}

export interface SaleDmVariant {
  id: string;
  label: string;
  designTemplate: string;
  tone: string;
  length: string;
  appeal: string;
  strength: string;
  extraInstruction: string | null;
  // 型ごとのLP(印刷QRの遷移先)。null=既定 SALE_DM_LP_URL へ。
  lpUrl: string | null;
}

export interface SaleDmCampaign {
  id: string;
  name: string;
  status: string;
  variants: SaleDmVariant[];
  recipients: SaleDmDraft[];
}

export async function fetchSaleDmCampaign(id: string) {
  if (USE_MOCK) {
    await mockDelay();
    return { campaign: { id, name: "モック売却DM", status: "draft", variants: [], recipients: [] } as SaleDmCampaign };
  }
  return apiFetch<{ campaign: SaleDmCampaign }>(`/api/properties/sale-dm/campaigns/${id}`);
}

// outcome PATCH(配達結果 / 電話反響)。payload 型はインライン(循環 import 回避)。
export async function updateSaleDmOutcome(
  id: string,
  payload: { deliveryStatus?: string; phoneInquiry?: boolean },
) {
  if (USE_MOCK) {
    await mockDelay();
    return { id };
  }
  return apiFetch<{ id: string }>(`/api/properties/sale-dm/drafts/${id}/outcome`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// 下書きの本文 / 割当型(variantId)の部分更新。
export async function patchSaleDmDraft(id: string, patch: { body?: string; variantId?: string }) {
  if (USE_MOCK) {
    await mockDelay();
    return { id };
  }
  return apiFetch<{ id: string }>(`/api/properties/sale-dm/drafts/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

// 割当型 + 個別上書きで本文を AI 再生成する。
export async function regenerateSaleDmDraft(id: string) {
  if (USE_MOCK) {
    await mockDelay();
    return { id, body: "（mock再生成）本文" };
  }
  return apiFetch<{ id: string; body: string }>(`/api/properties/sale-dm/drafts/${id}/regenerate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // 課金確認(有料AI+オーナーPII外部送信)。UI が確認ダイアログの後に呼ぶ。サーバーも必須。
    body: JSON.stringify({ confirmed: true }),
  });
}

// ---------- A/B 型(variant)管理 + 割当 + 宛先不明の手動解除 ----------

export interface SaleDmVariantOptions {
  designTemplate: string;
  tone: string;
  length: string;
  appeal: string;
  strength: string;
  extraInstruction?: string;
}

// A/B 型(B案/C案 等)を作成。label + options 一式 + 任意の lpUrl(型ごとのLP)。
export async function createSaleDmVariant(campaignId: string, body: { label: string; options: SaleDmVariantOptions; lpUrl?: string }) {
  if (USE_MOCK) {
    await mockDelay();
    return { variant: { id: `mock-${body.label}`, label: body.label, ...body.options, extraInstruction: body.options.extraInstruction ?? null, lpUrl: body.lpUrl ?? null } as SaleDmVariant };
  }
  return apiFetch<{ variant: SaleDmVariant }>(`/api/properties/sale-dm/campaigns/${campaignId}/variants`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// A/B 型のラベル/設定を部分更新。options を実際に変えると、この型を使う未送付下書きは無効化(要再生成)。
// lpUrl は型ごとのLP(本文に影響しない=無効化なし)。null で既定LPへ戻す(クリア)。
export async function updateSaleDmVariant(campaignId: string, variantId: string, body: { label?: string; options?: Partial<SaleDmVariantOptions>; lpUrl?: string | null }) {
  if (USE_MOCK) {
    await mockDelay();
    return { variant: { id: variantId } as SaleDmVariant };
  }
  return apiFetch<{ variant: SaleDmVariant }>(`/api/properties/sale-dm/campaigns/${campaignId}/variants/${variantId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// A/B 型を削除。割当済みの下書きがある型は 409(別型へ移してから)。
export async function deleteSaleDmVariant(campaignId: string, variantId: string) {
  if (USE_MOCK) {
    await mockDelay();
    return { deleted: variantId };
  }
  return apiFetch<{ deleted: string }>(`/api/properties/sale-dm/campaigns/${campaignId}/variants/${variantId}`, {
    method: "DELETE",
  });
}

// 宛先を型へ割り当て。auto=均等割り(sequential/random)、manual=指定(recipientId→variantId)。送付済みは対象外。
export async function assignSaleDmVariants(
  campaignId: string,
  body: { mode: "auto" | "manual"; order?: "sequential" | "random"; assignments?: { recipientId: string; variantId: string }[] },
) {
  if (USE_MOCK) {
    await mockDelay();
    return { assigned: 0, perVariant: {} as Record<string, number> };
  }
  return apiFetch<{ assigned: number; perVariant: Record<string, number> }>(`/api/properties/sale-dm/campaigns/${campaignId}/assign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// 物件の「宛先不明」フラグを手動解除(任意で dmStatus を send/hold へ戻す)。
export async function clearSaleDmUndeliverable(propertyId: string, body?: { restoreDmStatus?: "send" | "hold" }) {
  if (USE_MOCK) {
    await mockDelay();
    return { id: propertyId, dmStatus: body?.restoreDmStatus ?? "no_send" };
  }
  return apiFetch<{ id: string; dmStatus: string }>(`/api/properties/${propertyId}/clear-dm-undeliverable`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

// 下書き(draft)を一括で確定(confirmed)にする。印刷対象は confirmed のみ。
export async function confirmSaleDmDrafts(ids: string[]) {
  if (USE_MOCK) {
    await mockDelay();
    return { count: ids.length };
  }
  return apiFetch<{ count: number }>("/api/properties/sale-dm/drafts/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
}

// 確定済み(confirmed)の下書きを送付済み(sent)にする(配達結果/反響の入力が解禁)。
export async function markSaleDmDraftSent(id: string) {
  if (USE_MOCK) {
    await mockDelay();
    return { id, status: "sent" };
  }
  return apiFetch<{ id: string; status: string }>(`/api/properties/sale-dm/drafts/${id}/mark-sent`, {
    method: "POST",
  });
}

// 印刷用 HTML / DM差込CSV の URL(GET・別タブ/ダウンロード)。
export function saleDmPrintUrl(campaignId: string): string {
  return `/api/properties/sale-dm/campaigns/${campaignId}/print`;
}
export function saleDmExportUrl(campaignId: string): string {
  return `/api/properties/sale-dm/campaigns/${campaignId}/export`;
}

// ---------- 売却DM 設定(管理者) ----------
// 設定状況。APIキーは値を返さず hasAnthropicKey/hasOpenaiKey(設定済/未設定)のみ。
export interface SaleDmSettings {
  provider: string | null;
  model: string | null;
  trackingBaseUrl: string | null;
  lpUrl: string | null;
  senderName: string | null;
  senderContact: string | null;
  hasAnthropicKey: boolean;
  hasOpenaiKey: boolean;
  encryptionConfigured: boolean;
  updatedAt: string | null;
}

const EMPTY_SALE_DM_SETTINGS: SaleDmSettings = {
  provider: null, model: null, trackingBaseUrl: null, lpUrl: null,
  senderName: null, senderContact: null, hasAnthropicKey: false, hasOpenaiKey: false,
  encryptionConfigured: false, updatedAt: null,
};

export async function fetchSaleDmSettings(): Promise<{ data: SaleDmSettings }> {
  if (USE_MOCK) {
    await mockDelay();
    return { data: { ...EMPTY_SALE_DM_SETTINGS } };
  }
  return apiFetch<{ data: SaleDmSettings }>("/api/admin/sale-dm-settings");
}

// 部分更新。APIキーは指定時のみ送る(空文字=クリア・未指定=現状維持)。
export async function updateSaleDmSettings(body: {
  provider?: string | null;
  model?: string;
  trackingBaseUrl?: string;
  lpUrl?: string;
  senderName?: string;
  senderContact?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
}): Promise<{ data: SaleDmSettings }> {
  if (USE_MOCK) {
    await mockDelay();
    return { data: { ...EMPTY_SALE_DM_SETTINGS } };
  }
  return apiFetch<{ data: SaleDmSettings }>("/api/admin/sale-dm-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------- 会社情報(会社帯・管理者設定) ----------

export interface CompanyProfileSettings {
  nameJa: string;
  license: string;
  tel: string;
  fax: string;
  email: string;
  hp: string;
  address: string;
  updatedAt: string | null;
}

export const EMPTY_COMPANY_PROFILE_SETTINGS: CompanyProfileSettings = {
  nameJa: "", license: "", tel: "", fax: "", email: "", hp: "", address: "", updatedAt: null,
};

export async function fetchCompanySettings(): Promise<{ data: CompanyProfileSettings }> {
  if (USE_MOCK) {
    await mockDelay();
    return { data: { ...EMPTY_COMPANY_PROFILE_SETTINGS } };
  }
  return apiFetch<{ data: CompanyProfileSettings }>("/api/admin/company-settings");
}

// 部分更新。空文字=クリア(→既定 COMPANY_INFO へフォールバック)・未指定=現状維持。
export async function updateCompanySettings(body: {
  nameJa?: string;
  license?: string;
  tel?: string;
  fax?: string;
  email?: string;
  hp?: string;
  address?: string;
}): Promise<{ data: CompanyProfileSettings }> {
  if (USE_MOCK) {
    await mockDelay();
    return { data: { ...EMPTY_COMPANY_PROFILE_SETTINGS } };
  }
  return apiFetch<{ data: CompanyProfileSettings }>("/api/admin/company-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------- 謄本取得の資格情報(登記情報提供サービス・管理者設定) ----------

export interface RegistrySettings {
  hasLoginId: boolean;
  hasPassword: boolean;
  encryptionConfigured: boolean;
  updatedAt: string | null;
}

const EMPTY_REGISTRY_SETTINGS: RegistrySettings = {
  hasLoginId: false,
  hasPassword: false,
  encryptionConfigured: false,
  updatedAt: null,
};

export async function fetchRegistrySettings(): Promise<RegistrySettings> {
  if (USE_MOCK) {
    await mockDelay();
    return { ...EMPTY_REGISTRY_SETTINGS };
  }
  return apiFetch<RegistrySettings>("/api/admin/registry-settings");
}

// 部分更新。資格情報(loginId/password)は指定時のみ送る(空文字=クリア・未指定=現状維持)。
export async function updateRegistrySettings(body: {
  loginId?: string;
  password?: string;
}): Promise<{ ok: boolean }> {
  if (USE_MOCK) {
    await mockDelay();
    return { ok: true };
  }
  return apiFetch<{ ok: boolean }>("/api/admin/registry-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------- Next Actions ----------

export async function fetchNextActions(
  propertyId: string,
  includeCompleted = false,
) {
  if (USE_MOCK) {
    await mockDelay();
    let actions = MOCK_NEXT_ACTIONS.filter(
      (a) => a.propertyId === propertyId,
    );
    if (!includeCompleted) {
      actions = actions.filter((a) => !a.isCompleted);
    }
    return { data: actions };
  }
  const params = includeCompleted ? "?includeCompleted=true" : "";
  return apiFetch<{ data: typeof MOCK_NEXT_ACTIONS }>(
    `/api/properties/${propertyId}/next-actions${params}`,
  );
}

export async function createNextAction(
  propertyId: string,
  data: { content: string; actionType?: string | null; scheduledAt: string; assignedTo: string },
) {
  if (USE_MOCK) {
    await mockDelay();
    return {
      id: "na-mock-" + Date.now(),
      propertyId,
      content: data.content,
      actionType: data.actionType ?? null,
      scheduledAt: data.scheduledAt,
      isCompleted: false,
      completedAt: null,
      assignee: { id: data.assignedTo, name: "モックユーザー" },
      creator: { id: "u1", name: "田中太郎" },
      createdAt: new Date().toISOString(),
    };
  }
  return apiFetch(`/api/properties/${propertyId}/next-actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function updateNextAction(
  propertyId: string,
  actionId: string,
  data: Record<string, unknown>,
) {
  if (USE_MOCK) {
    await mockDelay();
    return { id: actionId, ...data };
  }
  return apiFetch(`/api/properties/${propertyId}/next-actions/${actionId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function deleteNextAction(propertyId: string, actionId: string) {
  if (USE_MOCK) {
    await mockDelay();
    return { message: "削除しました" };
  }
  return apiFetch(`/api/properties/${propertyId}/next-actions/${actionId}`, {
    method: "DELETE",
  });
}

// ---------- Attachments ----------

export async function fetchAttachments(propertyId: string) {
  if (USE_MOCK) {
    await mockDelay();
    return { data: MOCK_ATTACHMENTS };
  }
  return apiFetch<{ data: typeof MOCK_ATTACHMENTS }>(
    `/api/properties/${propertyId}/attachments`,
  );
}

export async function deleteAttachment(propertyId: string, attachmentId: string) {
  if (USE_MOCK) {
    await mockDelay();
    return { message: "削除しました" };
  }
  return apiFetch(`/api/properties/${propertyId}/attachments/${attachmentId}`, {
    method: "DELETE",
  });
}

// ---------- Change Logs ----------

export async function fetchChangeLogs(
  propertyId: string,
  page = 1,
  filters?: { fieldName?: string; source?: string; from?: string; to?: string },
) {
  if (USE_MOCK) {
    await mockDelay();
    const logs = MOCK_CHANGE_LOGS.filter((l) => l.targetId === propertyId);
    return {
      data: logs,
      pagination: { page, limit: 50, total: logs.length, totalPages: 1 },
      fieldNames: [] as string[],
      sources: [] as string[],
    };
  }
  const params = new URLSearchParams({ page: String(page) });
  if (filters?.fieldName) params.set("fieldName", filters.fieldName);
  if (filters?.source) params.set("source", filters.source);
  if (filters?.from) params.set("from", filters.from);
  if (filters?.to) params.set("to", filters.to);
  return apiFetch<{
    data: typeof MOCK_CHANGE_LOGS;
    pagination: unknown;
    fieldNames?: string[];
    sources?: string[];
  }>(`/api/properties/${propertyId}/change-logs?${params}`);
}

// ---------- Candidates ----------

export async function fetchCandidates(propertyId: string) {
  if (USE_MOCK) {
    await mockDelay();
    return { data: MOCK_CANDIDATES, scanTruncated: false };
  }
  return apiFetch<{ data: typeof MOCK_CANDIDATES; scanTruncated?: boolean }>(
    `/api/properties/${propertyId}/candidates`,
  );
}

// ---------- Quality Check ----------

// 各ルールの全体件数・続き取得情報（非PII）。route の RuleMeta と対応。
export interface QualityRuleMeta {
  rule: string;
  severity: "error" | "warning" | "info";
  totalCount: number;
  returnedCount: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
}

// params 省略時は既定モード（summary + 各ルール先頭ページ + rules メタ）。
// rule/offset/limit 指定時はそのルールの1ページ分のみ（data + rules[1件]）を取得（残り issue の追加取得用）。
// propertyIds 指定時は scoped モード（指定物件のみ判定 + warningPropertiesTotal）。一覧バッジ用（17-C F2）。
export async function fetchQualityCheck(params?: {
  rule?: string;
  offset?: number;
  limit?: number;
  propertyIds?: string[];
}) {
  if (USE_MOCK) {
    await mockDelay();
    const scopedIds = params?.propertyIds;
    const issues = scopedIds
      ? MOCK_QUALITY_ISSUES.filter((i) => scopedIds.includes(i.propertyId))
      : MOCK_QUALITY_ISSUES;
    return {
      data: issues,
      summary: {
        total: issues.length,
        errors: issues.filter((i) => i.severity === "error").length,
        warnings: issues.filter((i) => i.severity === "warning").length,
        info: issues.filter((i) => i.severity === "info").length,
        propertiesChecked: scopedIds ? scopedIds.length : MOCK_PROPERTIES.length,
        issuesReturned: issues.length,
        issuesLimited: false,
        issueLimit: issues.length,
      },
      rules: [] as QualityRuleMeta[],
      // scoped モード時のみ（server 実装と同じ）: 警告(error/warning)あり物件の全体実数。
      ...(scopedIds
        ? {
            warningPropertiesTotal: new Set(
              MOCK_QUALITY_ISSUES.filter((i) => i.severity !== "info").map(
                (i) => i.propertyId,
              ),
            ).size,
          }
        : {}),
    };
  }
  const qs = new URLSearchParams();
  if (params?.rule) qs.set("rule", params.rule);
  if (params?.offset != null) qs.set("offset", String(params.offset));
  if (params?.limit != null) qs.set("limit", String(params.limit));
  if (params?.propertyIds) qs.set("propertyIds", params.propertyIds.join(","));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return apiFetch<{
    data: typeof MOCK_QUALITY_ISSUES;
    summary?: unknown;
    rules?: QualityRuleMeta[];
    warningPropertiesTotal?: number;
  }>(`/api/properties/quality-check${suffix}`);
}

// ---------- Users ----------

export async function fetchUsers() {
  if (USE_MOCK) {
    await mockDelay();
    return { data: MOCK_USERS };
  }
  return apiFetch<{ data: typeof MOCK_USERS }>("/api/users");
}

// ---------- Import Jobs ----------

export interface FetchImportJobsParams {
  jobType?: string;
  executedBy?: string;
  from?: string; // ISO 8601 (createdAt 下限)
  to?: string;   // ISO 8601 (createdAt 上限)
  page?: number;
  limit?: number;
}

export interface FetchImportJobsResponse {
  data: Array<
    (typeof MOCK_IMPORT_JOBS)[number] & {
      summary?: {
        createdCount: number;
        updatedCount: number;
        skippedCount: number;
        needsReviewCount: number;
        errorCount: number;
        totalCount: number;
      };
      // 手動で failed 化されたジョブかどうか（AuditLog 由来）
      isManuallyFailed?: boolean;
    }
  >;
  pagination?: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export async function fetchImportJobs(
  params: FetchImportJobsParams = {},
): Promise<FetchImportJobsResponse> {
  if (USE_MOCK) {
    await mockDelay();
    return { data: MOCK_IMPORT_JOBS };
  }
  const qs = new URLSearchParams();
  if (params.jobType) qs.set("jobType", params.jobType);
  if (params.executedBy) qs.set("executedBy", params.executedBy);
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);
  if (params.page != null) qs.set("page", String(params.page));
  if (params.limit != null) qs.set("limit", String(params.limit));
  const query = qs.toString();
  return apiFetch<FetchImportJobsResponse>(
    query ? `/api/import/jobs?${query}` : "/api/import/jobs",
  );
}

// PR-B(B1): rows サーバーサイドページング用の任意 query。
// 省略時は従来どおり全件取得（後方互換）。page / limit / status を渡すと
// detail API がページ分だけ rows を返す。
export interface FetchImportJobDetailParams {
  page?: number;
  limit?: number;
  status?: string;
  // 理由別 filter（Phase 2）: server の VALID_ROW_REASONS token。
  // 未指定なら query に載せない（全理由・後方互換）。
  reason?: string;
}

export async function fetchImportJobDetail(
  jobId: string,
  params: FetchImportJobDetailParams = {},
) {
  if (USE_MOCK) {
    await mockDelay();
    return {
      id: jobId,
      fileName: "mock-import.csv",
      status: "needs_review" as const,
      totalRows: 3,
      successCount: 1,
      errorCount: 1,
      needsReviewCount: 1,
      createdAt: "2025-06-01T10:00:00Z",
      // 段階A(PR-A): 詳細画面は job.summary を一意の真実として使うため、
      // mock 分岐でも summary を付与する（下の 3 行: 成功1 / 要レビュー1 / エラー1）。
      summary: {
        createdCount: 1,
        updatedCount: 0,
        skippedCount: 0,
        needsReviewCount: 1,
        errorCount: 1,
        totalCount: 3,
      },
      // PR-B(B1): server-side で確定する additive フィールド。
      isReceptionOwnerJob: false,
      duplicateCount: 0,
      // B4(Codex P2): bulk-resolve scope="duplicate" の対象件数（needs_review のみ・「重複」始まり）。
      duplicateActionableCount: 0,
      pagination: {
        page: 1,
        limit: 3,
        totalRows: 3,
        totalPages: 1,
        hasNextPage: false,
        hasPrevPage: false,
        status: null as string | null,
      },
      rows: [
        {
          id: "row-1",
          rowNumber: 1,
          status: "success" as const,
          data: { address: "東京都千代田区丸の内1-1-1", lotNumber: "1番1" },
          error: null,
          matchedPropertyId: "p1",
        },
        {
          id: "row-2",
          rowNumber: 2,
          status: "needs_review" as const,
          data: { address: "東京都港区六本木3-2-1", lotNumber: "3番2" },
          error: "類似物件が見つかりました",
          matchedPropertyId: null,
          candidates: [{ propertyId: "p2", address: "東京都港区六本木3-2-1", similarity: 0.95 }],
        },
        {
          id: "row-3",
          rowNumber: 3,
          status: "error" as const,
          data: { address: "", lotNumber: "" },
          error: "住所が空です",
          matchedPropertyId: null,
        },
      ],
    };
  }
  const query = new URLSearchParams();
  if (params.page != null) query.set("page", String(params.page));
  if (params.limit != null) query.set("limit", String(params.limit));
  if (params.status) query.set("status", params.status);
  if (params.reason) query.set("reason", params.reason);
  const qs = query.toString();
  return apiFetch(`/api/import/jobs/${jobId}${qs ? `?${qs}` : ""}`);
}

// processing のまま残っているスタックジョブの一覧。
export interface StuckImportJob {
  /** 「失敗にする」を出してよいか(server 側判定: 自分の実行分 or import:manage)。 */
  canMutate?: boolean;
  jobId: string;
  jobType: string;
  fileName: string;
  executor: { id: string; name: string };
  createdAt: string;
  startedAt: string | null;
  elapsedMinutes: number;
  rowCount: number;
}

export interface StuckImportJobsResponse {
  thresholdMinutes: number;
  data: StuckImportJob[];
}

export async function fetchStuckImportJobs(): Promise<StuckImportJobsResponse> {
  if (USE_MOCK) {
    await mockDelay();
    return { thresholdMinutes: 10, data: [] };
  }
  return apiFetch<StuckImportJobsResponse>("/api/import/jobs/stuck");
}

export async function markImportJobFailed(jobId: string) {
  if (USE_MOCK) {
    await mockDelay();
    return { data: { id: jobId, status: "failed" } };
  }
  return apiFetch<{ data: unknown }>(
    `/api/import/jobs/${jobId}/mark-failed`,
    { method: "PATCH" },
  );
}

// この取込で作成・更新された物件一覧（物件CSVジョブのみ）。
// 物件CSV以外 (owner_csv 等) のジョブでは applicable=false で返ってくる。
export interface AffectedProperty {
  rowNumber: number;
  propertyId: string;
  isUpdate: boolean;
  found: boolean;
  importSource: string;
  address: string | null;
  lotNumber: string | null;
  buildingNumber: string | null;
  roomNo: string | null;
  propertyType: string | null;
  buildingId: string | null;
  buildingName: string | null;
}

export interface AffectedPropertiesResponse {
  applicable: boolean;
  jobType: string;
  affected: AffectedProperty[];
  createdCount: number;
  updatedCount: number;
  missingCount: number;
}

export async function fetchAffectedProperties(
  jobId: string,
): Promise<AffectedPropertiesResponse> {
  if (USE_MOCK) {
    await mockDelay();
    return {
      applicable: false,
      jobType: "property_csv",
      affected: [],
      createdCount: 0,
      updatedCount: 0,
      missingCount: 0,
    };
  }
  return apiFetch<AffectedPropertiesResponse>(
    `/api/import/jobs/${jobId}/affected-properties`,
  );
}

export interface RollbackBlockedDetail {
  rowNumber: number;
  action: "delete" | "restore";
  reason: string;
}

export interface RollbackRestoreDetail {
  /** P2 修正: 同 propertyId を指す複数 row がある場合の代表値 (rowNumbers の最小値)。 */
  rowNumber: number;
  /** P2 修正: 同 propertyId を指す全 row の rowNumber 配列。非 PII。 */
  rowNumbers?: number[];
  propertyId: string;
  fieldNames: string[];
}

export interface RollbackResponse {
  alreadyRolledBack: boolean;
  eligible: boolean;
  ineligibleReason?: string;
  summary: {
    deletable: number;
    restorable: number;
    /** Phase 2: 復元可能 field の合計（property をまたいで合算）。未対応 API は undefined。 */
    restorableFieldCount?: number;
    blocked: number;
    skipped: number;
  };
  blockedDetails: RollbackBlockedDetail[];
  /** Phase 2: dryRun / execute 両方で返る per-property 復元 field 詳細（PII を含まない）。 */
  restoreDetails?: RollbackRestoreDetail[];
  executed: boolean;
  deletedCount?: number;
  /** Phase 2: 実 execute 時に復元した property 数 / field 数。 */
  restoredPropertyCount?: number;
  restoredFieldCount?: number;
}

export async function rollbackImportJob(
  jobId: string,
  dryRun: boolean,
): Promise<RollbackResponse> {
  if (USE_MOCK) {
    await mockDelay();
    return {
      alreadyRolledBack: false,
      eligible: false,
      ineligibleReason: "モックモードではロールバック未対応",
      summary: { deletable: 0, restorable: 0, blocked: 0, skipped: 0 },
      blockedDetails: [],
      executed: false,
    };
  }
  return apiFetch<RollbackResponse>(`/api/import/jobs/${jobId}/rollback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dryRun }),
  });
}

export async function resolveImportRow(
  jobId: string,
  rowId: string,
  action: "create_new" | "link_existing" | "skip" | "mark_error",
  targetId?: string,
  editedData?: Record<string, string>,
) {
  if (USE_MOCK) {
    await mockDelay();
    return { status: "success" };
  }
  return apiFetch(`/api/import/jobs/${jobId}/rows/${rowId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, targetId, editedData }),
  });
}

// B3: scope に一致する全 actionable 行を server-side で一括解決する（client は ID を持たない）。
// B4: scope に "duplicate"（重複候補のみ＝needs_review かつ errorMessage「重複」始まり）を追加。
export interface BulkResolveResponse {
  affectedCount: number;
}

export async function bulkResolveImportRows(
  jobId: string,
  body: {
    action: "skip" | "mark_error";
    scope: "needs_review" | "error" | "duplicate";
  },
): Promise<BulkResolveResponse> {
  if (USE_MOCK) {
    await mockDelay();
    return { affectedCount: 0 };
  }
  return apiFetch<BulkResolveResponse>(
    `/api/import/jobs/${jobId}/rows/bulk-resolve`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

export async function retryImportRow(
  jobId: string,
  rowId: string,
  editedData?: Record<string, string>,
) {
  if (USE_MOCK) {
    await mockDelay();
    return { status: "success" };
  }
  return apiFetch(`/api/import/jobs/${jobId}/rows/${rowId}/retry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ editedData }),
  });
}

export interface ManualLinkReceptionOwnerResponse {
  ok: true;
  rowId: string;
  propertyId: string;
  ownerCreatedCount: number;
  ownerLinkedCount: number;
  propertyUpdatedFields: string[];
}

/**
 * 受付帳×所有者ジョブの needs_review 行を、ユーザが選んだ Property に手動で紐づける。
 * 既存 PATCH /rows/:rowId の link_existing は変更せず、別パスの新 API を呼ぶ。
 */
export async function manualLinkReceptionOwnerRow(
  jobId: string,
  rowId: string,
  propertyId: string,
): Promise<ManualLinkReceptionOwnerResponse> {
  if (USE_MOCK) {
    await mockDelay();
    return {
      ok: true,
      rowId,
      propertyId,
      ownerCreatedCount: 0,
      ownerLinkedCount: 0,
      propertyUpdatedFields: [],
    };
  }
  return apiFetch<ManualLinkReceptionOwnerResponse>(
    `/api/import/jobs/${jobId}/rows/${rowId}/manual-link-reception-owner`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ propertyId }),
    },
  );
}

/**
 * ブラウザ側で csv/xlsx をプレビュー用の {headers, rows} に変換する。
 * API 送信時の整合性のため、サーバ側 sheet-parser と同じ粒度で文字列化する。
 * xlsx ライブラリは動的 import でチャンク分離する。
 */
export async function parseFileForPreview(
  file: File,
): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
  const name = file.name.toLowerCase();
  const toStr = (v: unknown): string => {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return "";
      if (Number.isInteger(v)) return String(v);
      const s = String(v);
      if (/e/i.test(s)) return v.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
      return s;
    }
    if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return String(v);
  };
  if (name.endsWith(".xlsx")) {
    const XLSX = await import("xlsx");
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) return { headers: [], rows: [] };
    const sheet = wb.Sheets[sheetName];
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: "",
      blankrows: false,
      raw: true,
    });
    if (!aoa || aoa.length === 0) return { headers: [], rows: [] };
    const headers = (aoa[0] ?? []).map((v) => toStr(v).trim());
    const rows: Record<string, string>[] = [];
    for (let i = 1; i < aoa.length; i++) {
      const row = aoa[i] ?? [];
      const values = headers.map((_, j) => toStr(row[j]).trim());
      if (values.every((v) => v === "")) continue;
      const record: Record<string, string> = {};
      headers.forEach((h, j) => (record[h] = values[j]));
      rows.push(record);
    }
    return { headers, rows };
  }
  // csv: UTF-8 BOM / UTF-8 / Shift-JIS(CP932) を自動判定。
  // file.text() 固定 (= UTF-8) だと Excel 出力の Shift-JIS が文字化けするため
  // 共通デコーダ経由に変更。
  const { readCsvFileAsText } = await import("./csv-decode");
  const text = await readCsvFileAsText(file);
  const { parseCsv } = await import("./csv-parser");
  const { headers, rows } = parseCsv(text);
  return { headers, rows };
}

/**
 * ブラウザの File を取込APIに渡せる形（csvText / xlsxBase64）に変換する。
 * 拡張子に応じて dispatch 先を決める。
 */
export async function readFileForImport(
  file: File,
): Promise<{ fileName: string; csvText?: string; xlsxBase64?: string }> {
  const name = file.name.toLowerCase();
  const isXlsx = name.endsWith(".xlsx");
  if (isXlsx) {
    const buf = await file.arrayBuffer();
    // ブラウザ環境で ArrayBuffer → base64
    const bytes = new Uint8Array(buf);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    const xlsxBase64 =
      typeof btoa !== "undefined"
        ? btoa(binary)
        : Buffer.from(binary, "binary").toString("base64");
    return { fileName: file.name, xlsxBase64 };
  }
  // CSV は UTF-8 BOM / UTF-8 / Shift-JIS(CP932) を自動判定して decode する。
  const { readCsvFileAsText } = await import("./csv-decode");
  const text = await readCsvFileAsText(file);
  return { fileName: file.name, csvText: text };
}

export async function importCsv(
  fileName: string,
  csvText: string | null,
  columnMapping?: Record<string, string>,
  xlsxBase64?: string,
) {
  if (USE_MOCK) {
    await mockDelay();
    const rows = (csvText ?? "").split("\n").length - 1;
    return {
      jobId: "ij-mock-" + Date.now(),
      totalRows: rows,
      successCount: Math.max(0, rows - 1),
      errorCount: 0,
      needsReviewCount: 1,
      parseErrors: [],
    };
  }
  const body: Record<string, unknown> = { fileName, columnMapping };
  if (csvText) body.csvText = csvText;
  if (xlsxBase64) body.xlsxBase64 = xlsxBase64;
  return apiFetch("/api/import/csv", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function previewCsvDuplicates(
  csvText: string | null,
  columnMapping?: Record<string, string>,
  fileName?: string,
  xlsxBase64?: string,
) {
  if (USE_MOCK) {
    await mockDelay();
    return { totalRows: 0, validRows: 0, errorRows: 0, duplicateCount: 0, duplicates: [] };
  }
  const body: Record<string, unknown> = { columnMapping, fileName };
  if (csvText) body.csvText = csvText;
  if (xlsxBase64) body.xlsxBase64 = xlsxBase64;
  return apiFetch("/api/import/csv/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function importOwnerCsv(
  fileName: string,
  csvText: string,
  columnMapping?: Record<string, string>,
) {
  if (USE_MOCK) {
    await mockDelay();
    const lines = csvText.trim().split("\n");
    const rows = Math.max(0, lines.length - 1);
    return {
      jobId: "ij-mock-" + Date.now(),
      totalRows: rows,
      successCount: rows,
      errorCount: 0,
      needsReviewCount: 0,
      linkedCount: 0,
    };
  }
  return apiFetch("/api/import/owner-csv", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileName, csvText, columnMapping }),
  });
}

// ---------- Relink owners (rescue existing unlinked owners) ----------

export interface RelinkOwnersResponse {
  candidateOwnerCount: number;
  linkedCount: number;
  linkedByLinkKeyCount: number;
  linkedByAddressCount: number;
  addressLinkAmbiguousCount: number;
}

export async function relinkOwners(): Promise<RelinkOwnersResponse> {
  if (USE_MOCK) {
    await mockDelay();
    return {
      candidateOwnerCount: 0,
      linkedCount: 0,
      linkedByLinkKeyCount: 0,
      linkedByAddressCount: 0,
      addressLinkAmbiguousCount: 0,
    };
  }
  return apiFetch<RelinkOwnersResponse>("/api/owners/relink", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
}

// ---------- Reception × Owner (2-file) ----------

export interface ReceptionOwnerPreviewResponse {
  summary: {
    receptionCount: number;
    ownerCount: number;
    ownerMatchedCount: number;
    ownerUnmatchedCount: number;
    propertyMatchedCount: number;
    propertyNotFoundCount: number;
    propertyMultipleCount: number;
    propertyNoKeyCount: number;
    excludedCount: number;
    excludedEmptyCount: number;
    excludedHeaderRepeatCount: number;
    excludedAggregateCount: number;
    excludedCoCollateralCount: number;
    filteredByDlCount: number;
    filteredByShinkiCount: number;
  };
  matchedSamples: Array<{
    rowNumber: number;
    matchKey: string;
    propertyId: string;
    propertyAddress: string;
    ownerCount: number;
    ownerNames: string[];
  }>;
  reviewSamples: Array<{
    rowNumber: number;
    matchKey: string;
    fColumn: string;
    kColumn: string;
    reason: "owner_unmatched" | "property_not_found" | "property_multiple" | "property_no_key";
    reasonLabel: string;
    candidateCount: number;
    ownerCount: number;
    propertyStatus: "matched" | "not_found" | "multiple" | "no_key";
    propertyId: string | null;
    candidatePropertyIds: string[];
    lotNumber: string | null;
    buildingNumber: string | null;
  }>;
  receptionFileType: ImportFileTypeInfo;
  ownerFileType: ImportFileTypeInfo;
}

/** B-11: サーバー側ファイル種別判定の表示用情報 (warning は注意喚起・任意)。 */
export interface ImportFileTypeInfo {
  type: string;
  label: string | null;
  error: string | null;
  warning?: string | null;
}

export type ReceptionDlFilter = "marked" | "unmarked" | "all";
export type ReceptionShinkiFilter = "existing" | "new" | "all";

export async function previewReceptionOwnerCsv(input: {
  receptionFileName: string;
  ownerFileName: string;
  receptionCsv?: string;
  ownerCsv?: string;
  receptionXlsxBase64?: string;
  ownerXlsxBase64?: string;
  dlFilter?: ReceptionDlFilter;
  shinkiFilter?: ReceptionShinkiFilter;
}): Promise<ReceptionOwnerPreviewResponse> {
  if (USE_MOCK) {
    await mockDelay();
    return {
      summary: {
        receptionCount: 0,
        ownerCount: 0,
        ownerMatchedCount: 0,
        ownerUnmatchedCount: 0,
        propertyMatchedCount: 0,
        propertyNotFoundCount: 0,
        propertyMultipleCount: 0,
        propertyNoKeyCount: 0,
        excludedCount: 0,
        excludedEmptyCount: 0,
        excludedHeaderRepeatCount: 0,
        excludedAggregateCount: 0,
        excludedCoCollateralCount: 0,
        filteredByDlCount: 0,
        filteredByShinkiCount: 0,
      },
      matchedSamples: [],
      reviewSamples: [],
      receptionFileType: { type: "reception", label: "受付帳として認識", error: null },
      ownerFileType: { type: "owner", label: "所有者として認識", error: null },
    };
  }
  return apiFetch<ReceptionOwnerPreviewResponse>("/api/import/reception-owner/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export interface ReceptionOwnerImportResponse {
  jobId: string;
  summary: ReceptionOwnerPreviewResponse["summary"];
  successCount: number;
  needsReviewCount: number;
  errorCount: number;
  propertyUpdatedCount: number;
  ownerCreatedCount: number;
  ownerLinkedCount: number;
}

export async function importReceptionOwnerCsv(input: {
  receptionFileName: string;
  ownerFileName: string;
  receptionCsv?: string;
  ownerCsv?: string;
  receptionXlsxBase64?: string;
  ownerXlsxBase64?: string;
  dlFilter?: ReceptionDlFilter;
  shinkiFilter?: ReceptionShinkiFilter;
}): Promise<ReceptionOwnerImportResponse> {
  if (USE_MOCK) {
    await mockDelay();
    return {
      jobId: "ij-mock-" + Date.now(),
      summary: {
        receptionCount: 0,
        ownerCount: 0,
        ownerMatchedCount: 0,
        ownerUnmatchedCount: 0,
        propertyMatchedCount: 0,
        propertyNotFoundCount: 0,
        propertyMultipleCount: 0,
        propertyNoKeyCount: 0,
        excludedCount: 0,
        excludedEmptyCount: 0,
        excludedHeaderRepeatCount: 0,
        excludedAggregateCount: 0,
        excludedCoCollateralCount: 0,
        filteredByDlCount: 0,
        filteredByShinkiCount: 0,
      },
      successCount: 0,
      needsReviewCount: 0,
      errorCount: 0,
      propertyUpdatedCount: 0,
      ownerCreatedCount: 0,
      ownerLinkedCount: 0,
    };
  }
  return apiFetch<ReceptionOwnerImportResponse>("/api/import/reception-owner", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

// ---------- Reception → Property (1-file) ----------

export interface ReceptionPropertyPreviewResponse {
  summary: {
    totalRows: number;
    filteredCount: number;
    noAddressCount: number;
    duplicateCount: number;
    toCreateCount: number;
  };
  toCreateSamples: Array<{
    rowNumber: number;
    fColumn: string;
    propertyAddress: string;
    lotNumber: string | null;
    buildingNumber: string | null;
  }>;
  duplicateSamples: Array<{
    rowNumber: number;
    propertyAddress: string;
    existingPropertyId: string;
  }>;
  receptionFileType: ImportFileTypeInfo;
}

export interface ReceptionPropertyImportResponse {
  jobId: string;
  successCount: number;
  needsReviewCount: number;
  errorCount: number;
}

export async function previewReceptionPropertyCsv(input: {
  receptionFileName: string;
  receptionCsv?: string;
  receptionXlsxBase64?: string;
  dlFilter?: ReceptionDlFilter;
  shinkiFilter?: ReceptionShinkiFilter;
}): Promise<ReceptionPropertyPreviewResponse> {
  if (USE_MOCK) {
    await mockDelay();
    return {
      summary: { totalRows: 0, filteredCount: 0, noAddressCount: 0, duplicateCount: 0, toCreateCount: 0 },
      toCreateSamples: [],
      duplicateSamples: [],
      receptionFileType: { type: "reception", label: "受付帳として認識", error: null },
    };
  }
  return apiFetch<ReceptionPropertyPreviewResponse>(
    "/api/import/reception-property/preview",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}

export async function importReceptionPropertyCsv(input: {
  receptionFileName: string;
  receptionCsv?: string;
  receptionXlsxBase64?: string;
  dlFilter?: ReceptionDlFilter;
  shinkiFilter?: ReceptionShinkiFilter;
}): Promise<ReceptionPropertyImportResponse> {
  if (USE_MOCK) {
    await mockDelay();
    return { jobId: "ij-mock-" + Date.now(), successCount: 0, needsReviewCount: 0, errorCount: 0 };
  }
  return apiFetch<ReceptionPropertyImportResponse>("/api/import/reception-property", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

// ============================================================
// 所有者事項PDF一括取込(registry_pdf_bulk)
// ============================================================

export interface RegistryPdfBulkUploadResponse {
  jobId: string;
  totalRows: number;
  acceptedCount: number;
  rejectedCount: number;
}

export async function uploadRegistryPdfBulk(
  files: File[],
): Promise<RegistryPdfBulkUploadResponse> {
  if (USE_MOCK) {
    await mockDelay();
    return {
      jobId: "ij-mock-" + Date.now(),
      totalRows: files.length,
      acceptedCount: files.length,
      rejectedCount: 0,
    };
  }
  const formData = new FormData();
  for (const f of files) formData.append("files", f);
  const res = await fetch("/api/import/registry-pdf-bulk", {
    method: "POST",
    body: formData,
  });
  if (!res.ok) throw await toApiError(res);
  return res.json();
}

export async function resumeRegistryPdfBulk(
  jobId: string,
): Promise<{ ok: boolean; pendingCount: number }> {
  if (USE_MOCK) {
    await mockDelay();
    return { ok: true, pendingCount: 0 };
  }
  return apiFetch(`/api/import/jobs/${jobId}/resume-registry-pdf`, {
    method: "POST",
  });
}

export async function manualAttachRegistryPdfRow(
  jobId: string,
  rowId: string,
  propertyId: string,
): Promise<{
  ok: boolean;
  rowId: string;
  propertyId: string;
  attachmentId: string;
}> {
  if (USE_MOCK) {
    await mockDelay();
    return {
      ok: true,
      rowId,
      propertyId,
      attachmentId: "att-mock-" + Date.now(),
    };
  }
  return apiFetch(
    `/api/import/jobs/${jobId}/rows/${rowId}/manual-attach-registry-pdf`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ propertyId }),
    },
  );
}

/** テキスト貼り付けモード (後方互換) */
export async function importRegistryPdf(
  text: string,
  propertyId?: string | null,
  fileName?: string,
  edited?: unknown,
) {
  if (USE_MOCK) {
    await mockDelay();
    return {
      jobId: "ij-mock-" + Date.now(),
      action: propertyId ? "updated" : "created",
      propertyId: propertyId ?? "p-mock-" + Date.now(),
      parsed: {
        realEstateNumber: "1300012345678",
        address: "東京都千代田区丸の内一丁目",
        lotNumber: "1番1",
        buildingNumber: null,
        landCategory: "宅地",
        area: "150.00",
        owners: [{ name: "山田太郎", address: "東京都千代田区丸の内1-1-1", share: null }],
        confidence: 0.85,
        warnings: [],
      },
    };
  }
  return apiFetch("/api/import/registry-pdf", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, propertyId, fileName, edited }),
  });
}

/** PDF ファイル送信モード (サーバー側テキスト抽出) */
export async function importRegistryPdfFile(
  file: File,
  propertyId?: string | null,
  fileName?: string,
  edited?: unknown,
) {
  if (USE_MOCK) {
    await mockDelay();
    return {
      jobId: "ij-mock-" + Date.now(),
      action: propertyId ? "updated" : "created",
      propertyId: propertyId ?? "p-mock-" + Date.now(),
      parsed: {
        realEstateNumber: "1300012345678",
        address: "東京都千代田区丸の内一丁目",
        lotNumber: "1番1",
        buildingNumber: null,
        landCategory: "宅地",
        area: "150.00",
        owners: [{ name: "山田太郎", address: "東京都千代田区丸の内1-1-1", share: null }],
        confidence: 0.85,
        warnings: [],
      },
    };
  }
  const form = new FormData();
  form.append("file", file, fileName ?? file.name);
  if (propertyId) form.append("propertyId", propertyId);
  if (edited !== undefined) form.append("edited", JSON.stringify(edited));
  // Content-Type は FormData 自動設定 (boundary 付き)
  return apiFetch("/api/import/registry-pdf", {
    method: "POST",
    body: form,
  });
}

/** PDF プレビュー専用 (DB書き込みなし) */
export async function parseRegistryPdfFile(file: File) {
  if (USE_MOCK) {
    await mockDelay();
    return {
      fileName: file.name,
      extractedTextLength: 500,
      extractionSource: "embedded_text" as const,
      isLikelyScanned: false,
      // Phase F-2a: 非破壊追加。文字数のみで raw text は含めない。
      extraction: { source: "embedded_text" as const, embeddedTextLength: 500 },
      parsed: {
        realEstateNumber: "1300012345678",
        address: "東京都千代田区丸の内一丁目",
        lotNumber: "1番1",
        buildingNumber: null,
        landCategory: "宅地",
        area: "150.00",
        owners: [{ name: "山田太郎", address: "東京都千代田区丸の内1-1-1", share: null }],
        confidence: 0.85,
        warnings: [],
      },
    };
  }
  const form = new FormData();
  form.append("file", file, file.name);
  return apiFetch("/api/import/registry-pdf/parse", {
    method: "POST",
    body: form,
  });
}

/**
 * scanned 謄本の OCR 下書き生成（preview 形を返す・DB 書込なし）。
 * admin 限定・OCR 未設定で 501・失敗は throw（呼び出し側で手動貼付 fallback）。
 */
export async function requestRegistryOcrDraft(file: File) {
  const form = new FormData();
  form.append("file", file, file.name);
  return apiFetch("/api/import/registry-pdf/ocr-draft", {
    method: "POST",
    body: form,
  });
}

// ---------- 謄本 所在検索（PR-2b: 番号無し物件を所在で検索→候補選択→取得） ----------
// 応答の候補には不動産番号は含まれない（cond③: 取得時に server 側で再解決する）。

export interface RegistrySearchCandidate {
  candidateRef: string;
  address: string | null;
  lotNumber: string | null;
  buildingNumber: string | null;
}

export type RegistrySearchResult =
  | { searchable: true; candidates: RegistrySearchCandidate[] }
  | {
      searchable: false;
      reason:
        | "has_real_estate_number"
        | "insufficient_location"
        // ⚠番号が無い/読めないは 422 で返るので画面のこの分岐には来ないが、
        //   型は共通の入口(search-request.ts)と揃えておく。
        | "missing_identifier"
        | "malformed_identifier";
    };

/**
 * 所在検索: 番号無し物件を所在/地番/家屋番号で謄本候補検索する（confirmed 必須）。
 * liveRef (任意) を渡すと、検索実行中の自動操作を実況パネル API
 * (fetchRegistryLiveView / registryLiveShotUrl) で追える。
 */
export async function searchRegistryCandidates(
  propertyId: string,
  liveRef?: string,
): Promise<RegistrySearchResult> {
  return apiFetch<RegistrySearchResult>(
    `/api/properties/${propertyId}/registry/search`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirmed: true,
        ...(liveRef ? { liveRef } : {}),
      }),
    },
  );
}

/** 実況パネルのステップ進行 (固定文言 + スクショ有無 + 完了フラグ)。 */
export interface RegistryLiveViewStep {
  seq: number;
  label: string;
  at: number;
  hasShot: boolean;
}

/** 実況パネルの進行状況を取得する (実行者本人のみ・404 は未開始/期限切れ)。 */
export async function fetchRegistryLiveView(
  propertyId: string,
  liveRef: string,
): Promise<{ data: { steps: RegistryLiveViewStep[]; done: boolean } }> {
  if (USE_MOCK) {
    await mockDelay();
    return { data: { steps: [], done: false } };
  }
  return apiFetch(
    `/api/properties/${propertyId}/registry/search/live/${encodeURIComponent(liveRef)}`,
  );
}

/**
 * 実況パネルの「中止」を要求する (実行者本人のみ)。
 *
 * ⚠**押した瞬間に止まるわけではない**。要求を立てるだけで、実際に止まるのは
 * 自動操作が**安全な節目**まで進んでから (途中で殺すと外部サイトを中途半端な
 * 状態で放り出す)。
 * ⚠候補検索の経路では**お金は動かない**ので、いつ止めても課金は発生しない。
 *
 * accepted:false = もう止める対象が無い (期限切れ / 既に完了)。
 */
export async function cancelRegistryLiveView(
  propertyId: string,
  liveRef: string,
): Promise<{ data: { accepted: boolean } }> {
  if (USE_MOCK) {
    await mockDelay();
    return { data: { accepted: true } };
  }
  return apiFetch(
    `/api/properties/${propertyId}/registry/search/live/${encodeURIComponent(liveRef)}/cancel`,
    { method: "POST" },
  );
}

/** 実況パネルのステップスクショ URL (img src 用・認可付き・no-store)。 */
export function registryLiveShotUrl(
  propertyId: string,
  liveRef: string,
  seq: number,
): string {
  return `/api/properties/${propertyId}/registry/search/live/${encodeURIComponent(liveRef)}/shot/${seq}`;
}

/** 候補を選んで謄本取得（cond③: candidateRef は取得時に server 側で再解決）。confirmed 必須。 */
export async function obtainRegistryByCandidate(
  propertyId: string,
  candidateRef: string,
  certificateType: "owner" | "all" = "owner",
): Promise<unknown> {
  return apiFetch(`/api/properties/${propertyId}/registry/auto-fetch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmed: true, candidateRef, certificateType }),
  });
}

// ---- 謄本 一括取得(PR-B・薄い版) ----

export interface RegistryFetchJobCreateResult {
  jobId: string;
  total: number;
  pending: number;
  skipped: number;
  /** 権限が無い/存在しない等でジョブに含めなかった件数。 */
  excluded: number;
}

export interface RegistryFetchJobCounts {
  total: number;
  pending: number;
  processing: number;
  done: number;
  failed: number;
  skipped: number;
  chargedButFailed: number;
}

export type RegistryFetchJobStatus =
  | "pending"
  | "processing"
  | "paused"
  | "completed"
  | "cancelled";

export type RegistryFetchItemStatus =
  | "pending"
  | "processing"
  | "done"
  | "failed"
  | "skipped"
  | "charged_but_failed";

export interface RegistryFetchJobProgress {
  jobId: string;
  status: RegistryFetchJobStatus;
  certificateType: "owner" | "all";
  pausedReason: string | null;
  activeItemId: string | null;
  counts: RegistryFetchJobCounts;
  items: Array<{
    id: string;
    propertyId: string | null;
    status: RegistryFetchItemStatus;
    errorCode: string | null;
  }>;
}

export interface RegistryFetchProcessResult {
  outcome:
    | "processed"
    | "skipped"
    | "rate_limited"
    | "drained"
    | "busy"
    | "paused"
    | "cancelled";
  jobStatus: RegistryFetchJobStatus;
  itemId?: string;
  itemStatus?: RegistryFetchItemStatus;
  errorCode?: string | null;
  morePending: boolean;
  /** rate_limited のとき、次の再試行まで待つべき最小 ms(サーバーの実効間隔)。 */
  retryAfterMs?: number;
}

/** 複数物件の一括取得ジョブを作る。idempotencyKey で再送時の二重作成を防ぐ。 */
export async function createRegistryFetchJob(
  propertyIds: string[],
  certificateType: "owner" | "all" = "owner",
  idempotencyKey?: string,
): Promise<RegistryFetchJobCreateResult> {
  return apiFetch<RegistryFetchJobCreateResult>("/api/registry-fetch/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmed: true, propertyIds, certificateType, idempotencyKey }),
  });
}

/** 一括ジョブの進捗を取得する(可視項目でフィルタ済み・件数は再計算値)。 */
export async function fetchRegistryFetchJob(
  jobId: string,
): Promise<RegistryFetchJobProgress> {
  return apiFetch<RegistryFetchJobProgress>(`/api/registry-fetch/jobs/${jobId}`);
}

/** pending 項目を1件だけ処理する(画面駆動の分割実行)。 */
export async function processNextRegistryFetchItem(
  jobId: string,
): Promise<RegistryFetchProcessResult> {
  return apiFetch<RegistryFetchProcessResult>(
    `/api/registry-fetch/jobs/${jobId}/process-next`,
    { method: "POST" },
  );
}

/** ジョブを中止する(節目で止まる)。 */
export async function cancelRegistryFetchJob(
  jobId: string,
): Promise<{ status: RegistryFetchJobStatus }> {
  return apiFetch(`/api/registry-fetch/jobs/${jobId}/cancel`, { method: "POST" });
}

/** 一時停止したジョブを再開する。 */
export async function resumeRegistryFetchJob(
  jobId: string,
): Promise<{ status: RegistryFetchJobStatus }> {
  return apiFetch(`/api/registry-fetch/jobs/${jobId}/resume`, { method: "POST" });
}

/** テキスト貼り付けプレビュー専用 (DB書き込みなし) */
export async function parseRegistryPdfText(text: string, fileName?: string) {
  if (USE_MOCK) {
    await mockDelay();
    return {
      fileName: fileName ?? "paste.txt",
      extractedTextLength: text.length,
      extractionSource: "embedded_text" as const,
      isLikelyScanned: false,
      // Phase F-2a: 非破壊追加
      extraction: {
        source: "embedded_text" as const,
        embeddedTextLength: text.length,
      },
      parsed: {
        realEstateNumber: "1300012345678",
        address: "東京都千代田区丸の内一丁目",
        lotNumber: "1番1",
        buildingNumber: null,
        landCategory: "宅地",
        area: "150.00",
        owners: [{ name: "山田太郎", address: "東京都千代田区丸の内1-1-1", share: null }],
        confidence: 0.85,
        warnings: [],
      },
    };
  }
  return apiFetch("/api/import/registry-pdf/parse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, fileName }),
  });
}

// ---------- Actions ----------

export async function executePropertyAction(
  propertyId: string,
  action: string,
  note?: string,
) {
  if (USE_MOCK) {
    await mockDelay();
    const messages: Record<string, string> = {
      confirm_investigation: "調査情報を確認しました",
      set_dm_send: "DM送付可に設定しました",
      set_dm_no_send: "DM送付不可に設定しました",
      set_dm_hold: "DM未判断に設定しました",
      advance_case_status: "案件ステータスを進めました",
      mark_registry_obtained: "登記取得済みに設定しました",
      assign_to_me: "自分を担当者に設定しました",
    };
    return { message: messages[action] ?? "アクション完了", property: null };
  }
  return apiFetch(`/api/properties/${propertyId}/actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, note }),
  });
}

// ---------- Bulk Update ----------

export async function bulkUpdateProperties(
  propertyIds: string[],
  updates: Record<string, unknown>,
) {
  if (USE_MOCK) {
    await mockDelay();
    return {
      message: `${propertyIds.length} 件の物件を更新しました`,
      updatedCount: propertyIds.length,
    };
  }
  return apiFetch("/api/properties/bulk-update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ propertyIds, updates }),
  });
}

// ---------- Photos ----------

export async function fetchPhotos(propertyId: string) {
  if (USE_MOCK) {
    await mockDelay();
    const photos = MOCK_PHOTOS.filter((p) => p.propertyId === propertyId);
    return { data: photos };
  }
  return apiFetch<{ data: typeof MOCK_PHOTOS }>(`/api/properties/${propertyId}/photos`);
}

export async function uploadPhoto(
  propertyId: string,
  data: { url: string; caption: string | null; sortOrder: number; createdAt: string },
) {
  if (USE_MOCK) {
    await mockDelay();
    const newPhoto = { id: "ph-mock-" + Date.now(), propertyId, ...data };
    return { data: newPhoto };
  }
  return apiFetch(`/api/properties/${propertyId}/photos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function deletePhoto(propertyId: string, photoId: string) {
  if (USE_MOCK) {
    await mockDelay();
    return { message: "削除しました" };
  }
  return apiFetch(`/api/properties/${propertyId}/photos/${photoId}`, {
    method: "DELETE",
  });
}

export async function updatePhoto(
  propertyId: string,
  photoId: string,
  data: { caption?: string | null; isPrimary?: boolean; sortOrder?: number },
) {
  if (USE_MOCK) {
    await mockDelay();
    return { data };
  }
  return apiFetch(
    `/api/properties/${propertyId}/photos/${photoId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    },
  );
}

// ---------- Building Photos ----------

export async function fetchBuildingPhotos(buildingId: string) {
  if (USE_MOCK) {
    await mockDelay();
    return { data: [] };
  }
  return apiFetch<{ data: BuildingPhotoData[] }>(
    `/api/buildings/${buildingId}/photos`,
  );
}

export async function uploadBuildingPhoto(
  buildingId: string,
  file: File,
  caption?: string,
) {
  if (USE_MOCK) {
    await mockDelay();
    return {
      data: {
        id: "bp-mock-" + Date.now(),
        buildingId,
        fileUrl: URL.createObjectURL(file),
        thumbnailUrl: null,
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type,
        caption: caption ?? null,
        sortOrder: 0,
        isPrimary: false,
        createdAt: new Date().toISOString(),
        photographer: { id: "mock", name: "Mock User" },
      } satisfies BuildingPhotoData,
    };
  }
  const formData = new FormData();
  formData.append("file", file);
  if (caption?.trim()) formData.append("caption", caption.trim());
  // Content-Type は FormData の場合ブラウザが自動設定するため指定しない
  return apiFetch<{ data: BuildingPhotoData }>(
    `/api/buildings/${buildingId}/photos`,
    { method: "POST", body: formData },
  );
}

export async function deleteBuildingPhoto(buildingId: string, photoId: string) {
  if (USE_MOCK) {
    await mockDelay();
    return { message: "削除しました" };
  }
  return apiFetch(`/api/buildings/${buildingId}/photos/${photoId}`, {
    method: "DELETE",
  });
}

export async function updateBuildingPhoto(
  buildingId: string,
  photoId: string,
  data: { caption?: string | null; isPrimary?: boolean; sortOrder?: number },
) {
  if (USE_MOCK) {
    await mockDelay();
    return { data };
  }
  return apiFetch<{ data: BuildingPhotoData }>(
    `/api/buildings/${buildingId}/photos/${photoId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    },
  );
}

export interface BuildingPhotoData {
  id: string;
  buildingId: string;
  fileUrl: string;
  thumbnailUrl: string | null;
  fileName: string;
  fileSize: number;
  mimeType: string;
  caption: string | null;
  sortOrder: number;
  isPrimary: boolean;
  createdAt: string;
  photographer: { id: string; name: string };
}

// ---------- Investigation Data ----------

export interface PropertyInvestigationData {
  id: string;
  propertyId: string;
  status: "draft" | "fetching" | "needs_review" | "confirmed" | "failed";
  sourceAddress: string | null;
  normalizedAddress: string | null;
  landLotNumber: string | null;
  latitude: number | null;
  longitude: number | null;
  zoningDistrict: string | null;
  buildingCoverageRatio: number | null;
  floorAreaRatio: number | null;
  hazardSummary: string | null;
  roadSummary: string | null;
  infrastructureSummary: string | null;
  autoFetchSummary: string | null;
  sourceSummary: string | null;
  // 住所正規化
  postalCode: string | null;
  municipalityCode: string | null;
  geocodePrecision: string | null;
  // 規制
  firePreventionArea: string | null;
  heightDistrict: string | null;
  // ハザード詳細
  floodRiskLevel: string | null;
  stormSurgeRiskLevel: string | null;
  tsunamiRiskLevel: string | null;
  sedimentRiskCategory: string | null;
  // 価格・周辺情報
  nearbyPriceSummary: string | null;
  landPriceSummary: string | null;
  facilitySummary: string | null;
  // 生データ・出典・エラー
  fieldSourcesJson: Record<string, unknown> | null;
  rawPayloadJson: Record<string, unknown> | null;
  lastFetchError: string | null;
  fetchVersion: number;
  fetchedAt: string | null;
  confirmedAt: string | null;
  confirmedBy: { id: string; name: string } | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  auditLogs: Array<{
    id: string;
    action: string;
    note: string | null;
    creator: { id: string; name: string };
    createdAt: string;
  }>;
}

/** GET /investigation – returns record or null */
export async function fetchPropertyInvestigation(
  propertyId: string,
): Promise<PropertyInvestigationData | null> {
  if (USE_MOCK) {
    await mockDelay();
    return null;
  }
  const res = await apiFetch<{ investigation: PropertyInvestigationData | null }>(
    `/api/properties/${propertyId}/investigation`,
  );
  return res.investigation;
}

/** POST /investigation/fetch – trigger providers, returns upserted record */
export async function triggerPropertyInvestigation(
  propertyId: string,
): Promise<PropertyInvestigationData> {
  if (USE_MOCK) {
    await mockDelay();
    return {
      id: "mock-inv-1",
      propertyId,
      status: "needs_review",
      sourceAddress: "モック住所",
      normalizedAddress: null,
      landLotNumber: null,
      latitude: 35.6762,
      longitude: 139.6503,
      zoningDistrict: "第一種住居地域",
      buildingCoverageRatio: 60,
      floorAreaRatio: 200,
      hazardSummary: "ハザードマップ: 洪水リスク低",
      roadSummary: "公道 / 幅員: 6m",
      infrastructureSummary: null,
      autoFetchSummary: "StubProvider: success",
      sourceSummary: "国土数値情報API（モック）",
      postalCode: null,
      municipalityCode: null,
      geocodePrecision: null,
      firePreventionArea: null,
      heightDistrict: null,
      floodRiskLevel: null,
      stormSurgeRiskLevel: null,
      tsunamiRiskLevel: null,
      sedimentRiskCategory: null,
      nearbyPriceSummary: null,
      landPriceSummary: null,
      facilitySummary: null,
      fieldSourcesJson: null,
      rawPayloadJson: null,
      lastFetchError: null,
      fetchVersion: 1,
      fetchedAt: new Date().toISOString(),
      confirmedAt: null,
      confirmedBy: null,
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      auditLogs: [],
    };
  }
  const res = await apiFetch<{ investigation: PropertyInvestigationData }>(
    `/api/properties/${propertyId}/investigation/fetch`,
    { method: "POST" },
  );
  return res.investigation;
}

/** PATCH /investigation – partial field update */
export async function patchPropertyInvestigation(
  propertyId: string,
  data: Record<string, string | number | null>,
): Promise<PropertyInvestigationData> {
  if (USE_MOCK) {
    await mockDelay();
    return {
      id: "mock-inv-1", propertyId, status: "needs_review",
      sourceAddress: null, normalizedAddress: null, landLotNumber: null,
      latitude: null, longitude: null, zoningDistrict: null,
      buildingCoverageRatio: null, floorAreaRatio: null, hazardSummary: null,
      roadSummary: null, infrastructureSummary: null, autoFetchSummary: null,
      sourceSummary: null,
      postalCode: null, municipalityCode: null, geocodePrecision: null,
      firePreventionArea: null, heightDistrict: null,
      floodRiskLevel: null, stormSurgeRiskLevel: null, tsunamiRiskLevel: null,
      sedimentRiskCategory: null,
      nearbyPriceSummary: null, landPriceSummary: null, facilitySummary: null,
      fieldSourcesJson: null, rawPayloadJson: null, lastFetchError: null, fetchVersion: 1,
      fetchedAt: null, confirmedAt: null, confirmedBy: null,
      version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      auditLogs: [],
      ...data,
    } as PropertyInvestigationData;
  }
  const res = await apiFetch<{ investigation: PropertyInvestigationData }>(
    `/api/properties/${propertyId}/investigation`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    },
  );
  return res.investigation;
}

/** POST /investigation/confirm – set status=confirmed */
export async function confirmPropertyInvestigation(
  propertyId: string,
): Promise<PropertyInvestigationData> {
  if (USE_MOCK) {
    await mockDelay();
    return {
      id: "mock-inv-1", propertyId, status: "confirmed",
      sourceAddress: null, normalizedAddress: null, landLotNumber: null,
      latitude: null, longitude: null, zoningDistrict: "第一種住居地域",
      buildingCoverageRatio: 60, floorAreaRatio: 200, hazardSummary: null,
      roadSummary: null, infrastructureSummary: null, autoFetchSummary: null,
      sourceSummary: null,
      postalCode: null, municipalityCode: null, geocodePrecision: null,
      firePreventionArea: null, heightDistrict: null,
      floodRiskLevel: null, stormSurgeRiskLevel: null, tsunamiRiskLevel: null,
      sedimentRiskCategory: null,
      nearbyPriceSummary: null, landPriceSummary: null, facilitySummary: null,
      fieldSourcesJson: null, rawPayloadJson: null, lastFetchError: null, fetchVersion: 1,
      fetchedAt: new Date().toISOString(),
      confirmedAt: new Date().toISOString(), confirmedBy: { id: "mock", name: "モックユーザー" },
      version: 2, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      auditLogs: [],
    };
  }
  const res = await apiFetch<{ investigation: PropertyInvestigationData }>(
    `/api/properties/${propertyId}/investigation/confirm`,
    { method: "POST" },
  );
  return res.investigation;
}

// Keep legacy exports for backward compatibility (used nowhere after page.tsx is updated)
export async function fetchInvestigationData(propertyId: string) {
  return fetchPropertyInvestigation(propertyId);
}
export async function triggerInvestigation(propertyId: string) {
  return triggerPropertyInvestigation(propertyId);
}
export async function confirmInvestigation(propertyId: string, _data?: unknown) {
  return confirmPropertyInvestigation(propertyId);
}

// ---------- Candidate Judgments ----------

export async function judgeCandidateAction(
  propertyId: string,
  candidateId: string,
  judgment: "same" | "different" | "pending",
) {
  if (USE_MOCK) {
    await mockDelay();
    const labels: Record<string, string> = {
      same: "同一物件として記録しました",
      different: "別物件として記録しました",
      pending: "保留にしました",
    };
    return { message: labels[judgment] ?? "記録しました" };
  }
  return apiFetch(`/api/properties/${propertyId}/candidates/${candidateId}/judge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ judgment }),
  });
}

// ---------- Buildings ----------

export async function fetchBuildings(keyword?: string) {
  if (USE_MOCK) {
    await mockDelay();
    return { data: [] };
  }
  const qs = keyword ? `?keyword=${encodeURIComponent(keyword)}` : "";
  return apiFetch<{ data: unknown[] }>(`/api/buildings${qs}`);
}

export async function fetchBuildingDetail(id: string) {
  if (USE_MOCK) {
    await mockDelay();
    return { id, name: "モックマンション", address: "東京都新宿区1-1", totalFloors: 10, totalUnits: 50 };
  }
  return apiFetch(`/api/buildings/${id}`);
}

export async function createBuilding(data: Record<string, unknown>) {
  if (USE_MOCK) {
    await mockDelay();
    return { id: "b-mock-" + Date.now(), ...data };
  }
  return apiFetch("/api/buildings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function updateBuilding(id: string, data: Record<string, unknown>) {
  if (USE_MOCK) {
    await mockDelay();
    return { id, ...data };
  }
  return apiFetch(`/api/buildings/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function deleteBuilding(id: string) {
  if (USE_MOCK) {
    await mockDelay();
    return { id, deleted: true };
  }
  return apiFetch<{ id: string; deleted: true }>(`/api/buildings/${id}`, {
    method: "DELETE",
  });
}

export async function fetchBuildingProperties(buildingId: string) {
  if (USE_MOCK) {
    await mockDelay();
    return { data: [] };
  }
  return apiFetch<{ data: unknown[] }>(`/api/buildings/${buildingId}/properties`);
}

export async function createBuildingUnit(
  buildingId: string,
  data: Record<string, unknown>,
) {
  if (USE_MOCK) {
    await mockDelay();
    return { id: "p-mock-" + Date.now(), ...data };
  }
  return apiFetch(`/api/buildings/${buildingId}/properties`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

// ---------- Suggest (autocomplete for property list) ----------

export async function fetchPropertySuggestions(q: string) {
  if (USE_MOCK) {
    await mockDelay();
    if (q.length < 2) return { data: [] };
    const ql = q.toLowerCase();
    return {
      data: MOCK_PROPERTIES.filter((p) =>
        p.address.toLowerCase().includes(ql),
      )
        .slice(0, 10)
        .map((p) => ({
          id: p.id,
          address: p.address,
          dmStatus: p.dmStatus,
          importSource: null as string | null,
          owners: [] as Array<{
            name: string | null;
            address: string | null;
            phone: string | null;
            zip: string | null;
            currentAddress: string | null;
            currentZip: string | null;
          }>,
        })),
    };
  }
  // Owner PII を URL に載せないため POST + body で送る（GETは廃止）
  return apiFetch<{
    data: Array<{
      id: string;
      address: string;
      dmStatus: string;
      importSource: string | null;
      owners: Array<{
        name: string | null;
        address: string | null;
        phone: string | null;
        zip: string | null;
        currentAddress: string | null;
        currentZip: string | null;
      }>;
    }>;
  }>(`/api/properties/suggest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q }),
  });
}

// ---------- Search (for import linkage) ----------

export async function searchProperties(query: string) {
  if (USE_MOCK) {
    await mockDelay();
    const q = query.toLowerCase();
    return {
      data: MOCK_PROPERTIES.filter(
        (p) =>
          p.address.toLowerCase().includes(q) ||
          p.lotNumber?.toLowerCase().includes(q),
      ).slice(0, 10),
    };
  }
  return apiFetch<{
    data: Array<{
      id: string;
      address: string;
      lotNumber: string | null;
      realEstateNumber: string | null;
      propertyType: string;
      externalLinkKey: string | null;
    }>;
  }>(`/api/properties/search?q=${encodeURIComponent(query)}`);
}

export async function updateOwner(
  id: string,
  data: { note?: string | null; version: number } & Record<string, unknown>,
) {
  if (USE_MOCK) {
    await mockDelay();
    return { id, ...data };
  }
  return apiFetch<{
    id: string;
    name: string;
    note: string | null;
    version: number;
  }>(`/api/owners/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

// 法人番号 lookup preview（Phase B）。Owner 行は更新しない。
// mock モードでは MockCorporateLookupProvider 相当のレスポンスを返す。
/** 入力種別。12桁=会社法人等番号 / 13桁=法人番号 / invalid。 */
export type CorporateIdentifierKindDTO =
  | "company_corporate_number_12"
  | "corporate_number_13"
  | "invalid";

/** 国税庁結果 vs 既存 Owner の不一致分類(生値ではなくフラグ)。 */
export type CorporateLookupConflictDTO = "match" | "conflict" | "unknown";

export interface CorporateLookupApiResponse {
  /** 入力種別(12桁/13桁)。route が server 側で解決。古い server では undefined。 */
  inputKind?: CorporateIdentifierKindDTO;
  /** 12桁入力時に算出した、または13桁入力をそのまま採用した解決済み13桁法人番号。 */
  resolvedCorporateNumber13?: string;
  /** 国税庁結果と既存 Owner 名/住所の不一致分類。 */
  conflict?: CorporateLookupConflictDTO;
  lookup: {
    found: boolean;
    isClosed: boolean;
    closeDate: string | null;
    closeCause: string | null;
    record: {
      corporateNumber: string;
      name: string;
      furigana: string | null;
      address: string;
      prefectureName: string | null;
      cityName: string | null;
      streetNumber: string | null;
      postCode: string | null;
      updateDate: string | null;
    } | null;
    fetchedAt: string;
    source: string;
  };
}

export async function lookupOwnerCorporateNumber(
  ownerId: string,
  corporateNumber: string,
): Promise<CorporateLookupApiResponse> {
  if (USE_MOCK) {
    await mockDelay();
    const fetchedAt = new Date().toISOString();
    if (corporateNumber === "9999999999999") {
      return {
        lookup: {
          found: false,
          isClosed: false,
          closeDate: null,
          closeCause: null,
          record: null,
          fetchedAt,
          source: "mock-corporate-lookup",
        },
      };
    }
    if (corporateNumber === "9888888888888") {
      return {
        lookup: {
          found: true,
          isClosed: true,
          closeDate: "2024-12-31",
          closeCause: "01",
          record: {
            corporateNumber,
            name: "廃止モック株式会社",
            furigana: "ハイシモックカブシキガイシャ",
            address: "東京都港区六本木1-1-1",
            prefectureName: "東京都",
            cityName: "港区",
            streetNumber: "六本木1-1-1",
            postCode: "1060032",
            updateDate: "2024-12-31",
          },
          fetchedAt,
          source: "mock-corporate-lookup",
        },
      };
    }
    return {
      lookup: {
        found: true,
        isClosed: false,
        closeDate: null,
        closeCause: null,
        record: {
          corporateNumber,
          name: "モック株式会社",
          furigana: "モックカブシキガイシャ",
          address: "東京都千代田区丸の内1-1-1",
          prefectureName: "東京都",
          cityName: "千代田区",
          streetNumber: "丸の内1-1-1",
          postCode: "1000005",
          updateDate: "2025-04-01",
        },
        fetchedAt,
        source: "mock-corporate-lookup",
      },
    };
  }
  return apiFetch<CorporateLookupApiResponse>(
    `/api/owners/${ownerId}/corporate-lookup`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ corporateNumber }),
    },
  );
}

// 法人番号 lookup 結果の Owner への反映実行（Phase C）。
// サーバ側で再 lookup → expectedRecord と一致するときのみ apply フィールドを更新する。
// rawData / PII は detail に残さない（AuditLog 仕様）。
export interface CorporateApplyRequest {
  corporateNumber: string;
  version: number;
  apply: {
    name: boolean;
    address: boolean;
    zip: boolean;
    corporateNumber: boolean;
  };
  expectedRecord: {
    corporateNumber: string;
    name: string;
    address: string;
    postCode: string | null;
    updateDate: string | null;
  };
  allowClosed?: boolean;
  /** conflict("明らかな不一致")時に反映を許可する確認フラグ(allowClosed と同型)。 */
  acknowledgeConflict?: boolean;
  /** 12桁で lookup した場合の元の会社法人等番号(12桁)。apply.corporateNumber=true 時に併せて保存。 */
  companyRegistryNumber?: string;
}

export interface CorporateApplyResponse {
  ok: true;
  owner: { id: string; version: number };
}

export async function applyOwnerCorporate(
  ownerId: string,
  payload: CorporateApplyRequest,
): Promise<CorporateApplyResponse> {
  if (USE_MOCK) {
    await mockDelay();
    return {
      ok: true,
      owner: { id: ownerId, version: payload.version + 1 },
    };
  }
  return apiFetch<CorporateApplyResponse>(
    `/api/owners/${ownerId}/corporate-apply`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

// 物件×所有者単位のメモなどを更新する（PropertyOwner.note）。
// Owner.note (所有者本体のメモ) とは別軸なので updateOwner と混同しない。
export async function updatePropertyOwner(
  propertyId: string,
  ownerId: string,
  data: { note?: string | null; relationship?: string | null; isPrimary?: boolean },
) {
  if (USE_MOCK) {
    await mockDelay();
    return { propertyId, ownerId, ...data };
  }
  return apiFetch<{
    id: string;
    propertyId: string;
    ownerId: string;
    note: string | null;
    relationship: string | null;
    isPrimary: boolean;
  }>(`/api/properties/${propertyId}/owners/${ownerId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function searchOwners(query: string) {
  if (USE_MOCK) {
    await mockDelay();
    return { data: [] };
  }
  return apiFetch<{
    data: Array<{
      id: string;
      name: string;
      nameKana: string | null;
      phone: string | null;
      address: string | null;
      externalLinkKey: string | null;
    }>;
  }>(`/api/owners/search?q=${encodeURIComponent(query)}`);
}

// 新規所有者の作成と物件への紐付けを 1 リクエストで atomic に行う（Codex P1 対応）。
// POST /api/properties/[id]/owners/create-and-link。サーバ側 transaction で owner 作成と
// PropertyOwner link を同時に成功/失敗させ、フロントでの createOwner→link 逐次実行で生じる
// orphan owner（作成されたが紐付かない）を防ぐ。
export async function createAndLinkOwnerToProperty(
  propertyId: string,
  payload: {
    name: string;
    nameKana?: string | null;
    phone?: string | null;
    zip?: string | null;
    address?: string | null;
    email?: string | null;
    relationship?: string | null;
    isPrimary?: boolean;
  },
) {
  if (USE_MOCK) {
    await mockDelay();
    return {
      owner: { id: "mock-owner-id", name: payload.name, version: 1 },
      propertyOwner: {
        id: "mock-property-owner-id",
        propertyId,
        ownerId: "mock-owner-id",
        relationship: payload.relationship ?? null,
        isPrimary: payload.isPrimary ?? false,
      },
    };
  }
  return apiFetch<{
    owner: { id: string; name: string; version: number };
    propertyOwner: {
      id: string;
      propertyId: string;
      ownerId: string;
      relationship: string | null;
      isPrimary: boolean;
    };
  }>(`/api/properties/${propertyId}/owners/create-and-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// 既存の所有者を物件に紐付ける（POST /api/properties/[id]/owners・linkOwnerSchema 準拠）。
export async function linkOwnerToProperty(
  propertyId: string,
  data: { ownerId: string; relationship?: string | null; isPrimary?: boolean },
) {
  if (USE_MOCK) {
    await mockDelay();
    return {
      id: "mock-property-owner-id",
      propertyId,
      ownerId: data.ownerId,
      relationship: data.relationship ?? null,
      isPrimary: data.isPrimary ?? false,
    };
  }
  return apiFetch<{
    id: string;
    propertyId: string;
    ownerId: string;
    relationship: string | null;
    isPrimary: boolean;
  }>(`/api/properties/${propertyId}/owners`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

// ---------- File Upload ----------

export async function uploadFile(
  propertyId: string,
  file: File,
  type: "photo" | "attachment",
  options?: { attachmentType?: "general" | "registry" },
) {
  if (USE_MOCK) {
    await mockDelay();
    return {
      data: {
        id: `${type}-mock-${Date.now()}`,
        fileName: file.name,
        fileUrl: URL.createObjectURL(file),
        fileSize: file.size,
        mimeType: file.type,
        type: options?.attachmentType ?? "general",
      },
    };
  }
  const formData = new FormData();
  formData.append("file", file);
  if (type === "attachment" && options?.attachmentType) {
    formData.append("type", options.attachmentType);
  }
  const endpoint =
    type === "photo"
      ? `/api/properties/${propertyId}/photos`
      : `/api/properties/${propertyId}/attachments`;
  const res = await fetch(endpoint, { method: "POST", body: formData });
  if (!res.ok) throw await toApiError(res);
  return res.json();
}

// ---------- Property Create ----------

export async function createProperty(data: {
  propertyType: string;
  address: string;
  postalCode?: string | null;
  lotNumber?: string | null;
  /** 物件名(任意)。集合住宅の種別のときだけ値が入る。 */
  buildingName?: string | null;
  introductionRoute?: string | null;
  note?: string | null;
}): Promise<{ id: string }> {
  if (USE_MOCK) {
    await mockDelay();
    return { id: "mock-new-property-id" };
  }
  return apiFetch<{ id: string }>("/api/properties", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

// ---------- Convert field-survey pin to property ----------

export async function convertPinToProperty(
  pinId: string,
  data: {
    propertyType: string;
    address: string;
    postalCode?: string | null;
    lotNumber?: string | null;
    buildingNumber?: string | null;
    realEstateNumber?: string | null;
  },
): Promise<{ id: string }> {
  if (USE_MOCK) {
    await mockDelay();
    return { id: "mock-converted-property-id" };
  }
  return apiFetch<{ id: string }>(
    `/api/field-survey/pins/${encodeURIComponent(pinId)}/convert-to-property`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) },
  );
}

/** suggestPinAddress の応答。precision: "rsdt"=号まで / "block"=番まで(ローカル照合) / "town"=町丁目まで。 */
export interface SuggestPinAddressResponse {
  result:
    | {
        found: true;
        address: string;
        precision?: "rsdt" | "block" | "town";
        /** 住居表示未実施地域のみ: 最寄り街区点の**地番**(地番欄の初期値候補・要確認)。 */
        lotNumber?: string;
      }
    | { found: false };
}

/** ピンの座標から住所（住居表示）を提案。座標は client に降ろさず server で解決。 */
export async function suggestPinAddress(
  pinId: string,
): Promise<SuggestPinAddressResponse> {
  if (USE_MOCK) {
    await mockDelay();
    return {
      result: {
        found: true,
        address: "東京都杉並区西荻北3-19-4",
        precision: "rsdt",
      },
    };
  }
  // POST 固定: 座標を外部へ送る副作用を持つため、cross-site 遷移(GET)で
  // 発動しないようにする(SameSite=Lax が cross-site POST を遮る)。
  return apiFetch<SuggestPinAddressResponse>(
    `/api/field-survey/pins/${encodeURIComponent(pinId)}/suggest-address`,
    { method: "POST" },
  );
}

/**
 * ピン 1 件の座標だけを取る (`/pins/[id]/location` = 座標のみ射影)。
 *
 * ⚠詳細 GET (`/pins/[id]`) は memo 本文まで返すため、**位置だけ見る操作では使わない**
 * (client のメモリに生 memo を乗せない)。
 * ⚠**押した / 開いた 1 件だけ**取りに行く。他人の pin を見ると server が
 * `field_survey_pin_view` を監査に残すので、一覧の全行分をまとめて取ると
 * 「見た」記録が積み上がって監査が意味を失う。
 *
 * 403 / 404 / 通信失敗はすべて null にまとめ、理由を呼び出し元へ持ち出さない
 * (fail-closed)。失敗を console にも出さない (座標・PII をログに残さない方針)。
 */
export async function fetchPinLocation(
  pinId: string,
): Promise<{ lat: number; lng: number } | null> {
  if (USE_MOCK) {
    await mockDelay();
    return { lat: 35.7038, lng: 139.5989 };
  }
  try {
    const res = await fetch(
      `/api/field-survey/pins/${encodeURIComponent(pinId)}/location`,
      { credentials: "same-origin" },
    );
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as {
      data?: { lat?: unknown; lng?: unknown };
    } | null;
    const lat = Number(body?.data?.lat);
    const lng = Number(body?.data?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  } catch {
    // 通信失敗 (オフライン等)。開き直しで再試行できるので静かに諦める。
    return null;
  }
}

export interface CandidatePinRow {
  id: string;
  staffUserId: string;
  createdAt: string;
  hasMemo?: boolean;
  /** 現地写真 cover サムネイル URL (場所特定用)。写真が無ければ null。 */
  coverPhotoUrl?: string | null;
  /** 現地写真の枚数。 */
  photoCount?: number;
}

/**
 * 物件化前の候補(candidate×open)を取得する。
 * 専用エンドポイントが座標・memo 本文を除外して返す(一覧は表示しない=非PII)。
 */
export async function listCandidatePins(
  order: "newest" | "oldest" = "newest",
): Promise<{
  data: CandidatePinRow[];
  /** 取得上限を超える候補があり、反対側の並びが data に含まれていない場合 true。 */
  truncated?: boolean;
}> {
  if (USE_MOCK) {
    await mockDelay();
    return { data: [], truncated: false };
  }
  return apiFetch<{ data: CandidatePinRow[]; truncated?: boolean }>(
    `/api/field-survey/pins/candidates?order=${order}`,
  );
}

// ---------- Audit Logs ----------

export async function fetchAuditLogs() {
  if (USE_MOCK) {
    await mockDelay();
    return { data: MOCK_AUDIT_LOGS };
  }
  return apiFetch<{ data: typeof MOCK_AUDIT_LOGS }>("/api/admin/audit-logs");
}

// ---------- Owner Correction Candidates (dry-run) ----------

export interface OwnerCorrectionCandidate {
  id: string;
  name: string | null;
  address: string | null;
  zip: string | null;
  phone: string | null;
  /**
   * Phase E: owner_corporate_number の display-level に従ったマスク済法人番号。
   * 事前確定方針:
   * - full → 生値
   * - edit/read/masked/partial → 先頭4桁+マスク
   * - hidden または Owner.corporateNumber が null → null
   */
  corporateNumberMasked: string | null;
  hasNote: boolean;
  hasExternalLinkKey: boolean;
  version: number;
  propertyOwnerCount: number;
  changeLogCount: number;
  importFileName: string | null;
  importRowNumber: number | null;
  blockReasons: string[];
  recommendedAction: "hold" | "review" | "delete_candidate" | "merge_candidate";
  types: string[];
  /**
   * duplicate グループに属する candidate のみ非 null（opaque ID、PII 復元不可）。
   * 経路ごとに prefix が異なる:
   *   - name_address      : "dup-N"
   *   - corporate_number  : "dup-cn-N"
   *   - external_link_key : "dup-elk-N"
   */
  duplicateGroupId: string | null;
  /** duplicate グループ内候補件数。duplicateGroupId が null なら null。 */
  duplicateGroupSize: number | null;
  /**
   * Phase 2-A: duplicate グループの一致経路。
   * 1 candidate が複数経路で同時にヒットしても 1 つだけ採用される
   * （優先順: name_address > corporate_number > external_link_key）。
   * duplicateGroupId が null なら null。
   */
  duplicateMatchedBy:
    | "name_address"
    | "corporate_number"
    | "external_link_key"
    | null;
  /**
   * Phase 2-B: address が DB 上 null ではないが trim 後に空欄
   * （半角/全角空白・タブ等のみ）の場合 true。boolean のみで PII を含まない。
   */
  addressIsWhitespaceOnly?: boolean;
}

export interface OwnerCorrectionCandidatesResponse {
  total: number;
  type: string;
  candidates: OwnerCorrectionCandidate[];
  summary: {
    orphanCount: number;
    addressNullCount: number;
    duplicateCount: number;
    /**
     * Phase 2-A: duplicate 経路別の件数（PII を含まない）。
     * candidate は単一の duplicateMatchedBy を持つので、合計値は
     * duplicateCount と一致する。
     */
    duplicateMatchedByCounts?: {
      name_address: number;
      corporate_number: number;
      external_link_key: number;
    };
    /**
     * Phase 2-A Codex P1: 法人番号重複検出が現セッションの表示権限で
     * 利用可能か（owner_corporate_number === "full" のみ true）。
     * false の場合、duplicateMatchedBy="corporate_number" の候補は
     * 一切 API レスポンスに含まれず matchedByCounts.corporate_number=0 となる。
     * UI は権限不足メッセージの表示判断に使う。値は boolean のみで PII を含まない。
     */
    corporateNumberDuplicateAvailable?: boolean;
    allCount: number;
  };
}

export async function fetchOwnerCorrectionCandidates(
  type: "all" | "orphan" | "address_null" | "duplicate" = "all",
): Promise<OwnerCorrectionCandidatesResponse> {
  if (USE_MOCK) {
    await mockDelay();
    return {
      total: 0,
      type,
      candidates: [],
      summary: { orphanCount: 0, addressNullCount: 0, duplicateCount: 0, allCount: 0 },
    };
  }
  return apiFetch<OwnerCorrectionCandidatesResponse>(
    `/api/admin/owners/correction-candidates?type=${type}`,
  );
}

// ---------- Phase E: 法人番号混入 candidate (dry-run) ----------

export type CorporateCandidateFilterType =
  | "all"
  | "missing"
  | "conflict"
  | "multi"
  | "same";

export interface CorporateCandidateRowDTO {
  ownerId: string;
  ownerNameMasked: string | null;
  ownerAddressMasked: string | null;
  existingCorporateNumberMasked: string | null;
  candidateCorporateNumberMasked: string | null;
  candidateCount: 1 | "many";
  detectedIn: Array<"name" | "address" | "note">;
  type: "missing" | "same" | "conflict" | "multi";
  version: number;
  detailUrl: string;
}

export interface CorporateCandidatesResponse {
  type: CorporateCandidateFilterType;
  candidates: CorporateCandidateRowDTO[];
  summary: {
    missing: number;
    conflict: number;
    multi: number;
    same: number;
    totalCandidates: number;
  };
  hasNextPage: boolean;
  nextCursor: string | null;
  truncated: boolean;
}

// Phase F: 単一 Owner の法人番号候補（Phase E と同じ分類）+ Owner 概要を返す。
// レスポンス内で「候補値」「既存法人番号」は display-level に従いマスク済み。
export interface AdminOwnerCorporateCandidateResponse {
  owner: {
    ownerId: string;
    /** 登記上の住所（マスク済み） */
    ownerAddressMasked: string | null;
    ownerNameMasked: string | null;
    /** 現住所（マスク済み・未設定なら null） */
    ownerCurrentAddressMasked: string | null;
    existingCorporateNumberMasked: string | null;
    version: number;
    propertyOwnerCount: number;
  };
  candidate: CorporateCandidateRowDTO | null;
}

export async function fetchAdminOwnerCorporateCandidate(
  ownerId: string,
): Promise<AdminOwnerCorporateCandidateResponse> {
  if (USE_MOCK) {
    await mockDelay();
    return {
      owner: {
        ownerId,
        ownerNameMasked: null,
        ownerAddressMasked: null,
        ownerCurrentAddressMasked: null,
        existingCorporateNumberMasked: null,
        version: 1,
        propertyOwnerCount: 0,
      },
      candidate: null,
    };
  }
  return apiFetch<AdminOwnerCorporateCandidateResponse>(
    `/api/admin/owners/${ownerId}/corporate-candidate`,
  );
}

export async function fetchCorporateCandidates(
  type: CorporateCandidateFilterType = "all",
  options?: { limit?: number; cursor?: string | null },
): Promise<CorporateCandidatesResponse> {
  if (USE_MOCK) {
    await mockDelay();
    return {
      type,
      candidates: [],
      summary: {
        missing: 0,
        conflict: 0,
        multi: 0,
        same: 0,
        totalCandidates: 0,
      },
      hasNextPage: false,
      nextCursor: null,
      truncated: false,
    };
  }
  const params = new URLSearchParams({ type });
  if (options?.limit != null) params.set("limit", String(options.limit));
  if (options?.cursor) params.set("cursor", options.cursor);
  return apiFetch<CorporateCandidatesResponse>(
    `/api/admin/owners/correction/corporate-number-candidates?${params.toString()}`,
  );
}

// ---------- 法人番号 一括反映（missing 候補 → 検出番号 lookup → 番号のみ反映） ----------
// server route: POST /api/admin/owners/correction/corporate-number-bulk-apply
// client は {ownerId, version} のみ送る。検出 / 国税庁 lookup / 廃止判定は server が再実行する。
// version は楽観ロック用（stale でも server 側で version_conflict として安全に skip）。
export type BulkCorporateApplyStatus =
  | "applied"
  | "already_set"
  | "not_found"
  | "version_conflict"
  | "no_single_detection"
  | "lookup_no_result"
  | "closed"
  | "lookup_error"
  | "not_processed";

export interface BulkCorporateApplyItem {
  ownerId: string;
  version: number;
}

export interface BulkCorporateApplyResultRow {
  ownerId: string;
  status: BulkCorporateApplyStatus;
}

export interface BulkCorporateApplyResponse {
  results: BulkCorporateApplyResultRow[];
  requested: number;
  applied: number;
}

export async function bulkApplyCorporateNumbers(
  owners: BulkCorporateApplyItem[],
): Promise<BulkCorporateApplyResponse> {
  if (USE_MOCK) {
    await mockDelay();
    return {
      results: owners.map((o) => ({
        ownerId: o.ownerId,
        status: "applied" as const,
      })),
      requested: owners.length,
      applied: owners.length,
    };
  }
  return apiFetch<BulkCorporateApplyResponse>(
    "/api/admin/owners/correction/corporate-number-bulk-apply",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owners }),
    },
  );
}

// ---------- 割れた会社法人等番号の復元(候補一覧 / 一括復元) ----------
// server route: GET  /api/admin/owners/correction/corporate-restore-candidates
//               POST /api/admin/owners/correction/corporate-restore-apply
// client は {ownerId, version} と addressMode のみ送る。検出・復元・国税庁 lookup は
// server が再実行する(client は信頼境界外)。マスキングは server 側で適用済み。

export type SplitCorporateTypeDTO =
  | "address_name_split"
  | "name_fragment"
  | "number_set_name_lost";

export interface CorporateRestoreRowDTO {
  ownerId: string;
  type: SplitCorporateTypeDTO;
  ownerNameMasked: string | null;
  ownerAddressMasked: string | null;
  registry12Masked: string | null;
  corporate13Masked: string | null;
  cleanedNameMasked: string | null;
  eligible: boolean;
  version: number;
  detailUrl: string;
}

export interface CorporateRestoreCandidatesResponse {
  rows: CorporateRestoreRowDTO[];
  summary: {
    split: number;
    fragment: number;
    nameLost: number;
    total: number;
  };
  truncated: boolean;
}

export async function fetchCorporateRestoreCandidates(): Promise<CorporateRestoreCandidatesResponse> {
  if (USE_MOCK) {
    await mockDelay();
    return {
      rows: [],
      summary: { split: 0, fragment: 0, nameLost: 0, total: 0 },
      truncated: false,
    };
  }
  return apiFetch<CorporateRestoreCandidatesResponse>(
    "/api/admin/owners/correction/corporate-restore-candidates",
  );
}

export type CorporateRestoreApplyStatus =
  | "applied"
  | "not_found"
  | "version_conflict"
  | "no_detection"
  | "not_eligible"
  | "lookup_no_result"
  | "closed"
  | "lookup_error"
  | "not_processed";

/** 住所の反映モード: nta=国税庁の最新本店所在地(+郵便番号) / cleaned=断片除去のみ */
export type CorporateRestoreAddressMode = "nta" | "cleaned";

export interface CorporateRestoreApplyResultRow {
  ownerId: string;
  status: CorporateRestoreApplyStatus;
}

export interface CorporateRestoreApplyResponse {
  results: CorporateRestoreApplyResultRow[];
  requested: number;
  applied: number;
}

export async function applyCorporateRestore(
  owners: BulkCorporateApplyItem[],
  addressMode: CorporateRestoreAddressMode,
): Promise<CorporateRestoreApplyResponse> {
  if (USE_MOCK) {
    await mockDelay();
    return {
      results: owners.map((o) => ({
        ownerId: o.ownerId,
        status: "applied" as const,
      })),
      requested: owners.length,
      applied: owners.length,
    };
  }
  return apiFetch<CorporateRestoreApplyResponse>(
    "/api/admin/owners/correction/corporate-restore-apply",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owners, addressMode }),
    },
  );
}

// ---------- Address lookup (郵便番号 / 住所補完) ----------
// APIキーは server-side route (/api/address/lookup/*) と server lib 内でのみ使う。
// client はここから route を叩くだけで APIキー(secret env) には一切触れない
// （外部 API を client から直接呼ばない＝server-side proxy 経由に統一）。

/** 郵便番号 → 住所候補。route 経由で取得する。 */
export async function fetchAddressByPostalCode(
  zip: string,
): Promise<{ candidates: AddressLookupCandidate[] }> {
  if (USE_MOCK) {
    await mockDelay();
    return {
      candidates: [
        {
          postalCode: "1000005",
          prefecture: "東京都",
          city: "千代田区",
          town: "丸の内",
          addressLine: "東京都千代田区丸の内",
          source: "mock",
        },
      ],
    };
  }
  return apiFetch<{ candidates: AddressLookupCandidate[] }>(
    `/api/address/lookup/postal-code?zip=${encodeURIComponent(zip)}`,
  );
}

/**
 * 住所文字列 → 郵便番号付き候補。route 経由で取得する。
 * 住所は URL に載せず POST body で送る（住所 PII を browser history / proxy / access log に残さない）。
 */
export async function fetchAddressCandidates(
  address: string,
): Promise<{ candidates: AddressLookupCandidate[] }> {
  if (USE_MOCK) {
    await mockDelay();
    return {
      candidates: [
        {
          postalCode: "1000005",
          prefecture: "東京都",
          city: "千代田区",
          town: "丸の内",
          addressLine: address,
          source: "mock",
        },
      ],
    };
  }
  return apiFetch<{ candidates: AddressLookupCandidate[] }>(
    "/api/address/lookup/search",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    },
  );
}

// ---------- Corporate lookup (法人番号 → 法人名・本店所在地) ----------
// APIキー(CORPORATE_NUMBER_API_APP_ID)は server-side route (/api/corporate/lookup) と server lib
// (@/lib/corporate-lookup) 内でのみ使う。client はここから route を叩くだけで appId(secret env)
// には一切触れない（外部 NTA API を client から直接呼ばない＝server-side proxy 経由に統一）。

/**
 * 法人番号 → 法人名・本店所在地の候補。route 経由で取得する。
 * 法人番号は URL に載せず POST body で送る（PR-2b の教訓: 識別子を browser history /
 * proxy / access log に残さない）。0件は candidates:[]、廃止法人も record を候補に含める。
 */
export async function fetchCorporateLookup(
  corporateNumber: string,
): Promise<{ candidates: CorporateLookupRecord[] }> {
  if (USE_MOCK) {
    await mockDelay();
    return {
      candidates: [
        {
          corporateNumber,
          name: "モック株式会社",
          furigana: "モックカブシキガイシャ",
          address: "東京都千代田区丸の内１−１−１",
          prefectureName: "東京都",
          cityName: "千代田区",
          streetNumber: "丸の内１−１−１",
          postCode: "1000005",
          updateDate: "2025-04-01",
        },
      ],
    };
  }
  return apiFetch<{ candidates: CorporateLookupRecord[] }>(
    "/api/corporate/lookup",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ corporateNumber }),
    },
  );
}

// ---------- 郵便番号×住所 整合チェック（read-only レポート） ----------

export type PostalAuditVerdict = "match" | "mismatch" | "indeterminate";
export type PostalAuditIndeterminateReason =
  | "invalid_postal_code"
  | "address_empty"
  | "no_candidate"
  | "lookup_unavailable"
  // 時間バジェット超過で照合まで到達しなかった（未処理）owner。route は silent に
  // 切り捨てず、verdict=indeterminate / reason=not_processed の行として返す（Codex P1）。
  | "not_processed";

export interface PostalAuditRowDTO {
  ownerId: string;
  nameMasked: string | null;
  zipMasked: string | null;
  addressMasked: string | null;
  apiAddressLine: string | null;
  verdict: PostalAuditVerdict;
  reason: PostalAuditIndeterminateReason | null;
}

export interface PostalCodeAuditResponse {
  apiConfigured: boolean;
  truncated: boolean;
  // 時間バジェット（POSTAL_AUDIT_TIME_BUDGET_MS）超過で未処理 owner が出たか（Codex P1）。
  timeBudgetExhausted: boolean;
  // 実際に照合まで到達した owner 件数。
  processed: number;
  // 時間バジェット超過などで未処理（not_processed）になった owner 件数。
  notProcessed: number;
  maxTargets: number;
  // lookup ループの経過時間バジェット（ミリ秒）。通知文言の根拠に使う。
  timeBudgetMs: number;
  summary: {
    total: number;
    match: number;
    mismatch: number;
    indeterminate: number;
  };
  rows: PostalAuditRowDTO[];
}

/** 郵便番号×住所 整合チェックレポートを取得する（read-only）。 */
export async function fetchPostalCodeAudit(): Promise<PostalCodeAuditResponse> {
  if (USE_MOCK) {
    await mockDelay();
    return {
      apiConfigured: false,
      truncated: false,
      timeBudgetExhausted: false,
      processed: 0,
      notProcessed: 0,
      maxTargets: 200,
      timeBudgetMs: 45000,
      summary: { total: 0, match: 0, mismatch: 0, indeterminate: 0 },
      rows: [],
    };
  }
  return apiFetch<PostalCodeAuditResponse>("/api/admin/postal-code-audit");
}

// ---------- DM送付管理(PR-A): 宛名CSVの控えと送付確定 ----------

export interface DmBatchSummary {
  id: string;
  createdAt: string;
  rowCount: number;
  downloadedAt: string | null;
  confirmedAt: string | null;
  /** 作成者名(スタッフ名=非PII)。admin/office が複数人の控えを見分けるための表示。 */
  creatorName: string;
}

/**
 * 宛名CSV出力の第1段: 検索条件を評価して控え(バッチ)を作る。
 * attemptKey は押下ごとに client で採番(本番はHTTPのため crypto.randomUUID は使わない)。
 * 返った batchId の GET /csv へブラウザ遷移してダウンロードする(第2段)。
 */
export async function createDmBatch(filters: Record<string, string>): Promise<{
  batchId: string;
  rowCount: number;
  reused: boolean;
  /** 拒否・宛先不明の反響で自動除外した宛先数(再利用時は undefined)。 */
  excludedTerminalCount?: number;
}> {
  if (USE_MOCK) {
    await mockDelay();
    return {
      batchId: "mock-batch-1",
      rowCount: 3,
      reused: false,
      excludedTerminalCount: 0,
    };
  }
  return apiFetch("/api/properties/dm-batches", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filters, attemptKey: safeRandomId() }),
  });
}

/** 送付確定モーダル用: 未確定の控え一覧(非PII・50件ページング)。 */
export async function fetchUnconfirmedDmBatches(page = 1): Promise<{
  data: DmBatchSummary[];
  page: number;
  hasMore: boolean;
}> {
  if (USE_MOCK) {
    await mockDelay();
    return {
      data: [
        {
          id: "mock-batch-1",
          createdAt: new Date().toISOString(),
          rowCount: 3,
          downloadedAt: new Date().toISOString(),
          confirmedAt: null,
          creatorName: "モック 太郎",
        },
      ],
      page: 1,
      hasMore: false,
    };
  }
  return apiFetch<{ data: DmBatchSummary[]; page: number; hasMore: boolean }>(
    `/api/properties/dm-batches?unconfirmed=1&page=${page}`,
  );
}

/** 送付確定: 投函日(YYYY-MM-DD)を入れて控えの宛先全件を送付記録にする。 */
export async function confirmDmBatch(
  batchId: string,
  sentOn: string,
): Promise<{ confirmed: number }> {
  if (USE_MOCK) {
    await mockDelay();
    return { confirmed: 3 };
  }
  return apiFetch<{ confirmed: number }>(
    `/api/properties/dm-batches/${batchId}/confirm`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sentOn }),
    },
  );
}

/** 個別の送付記録(手渡し等)を追加する。sentOn=YYYY-MM-DD(過去日可・今日以前)。 */
export async function createPropertyDmLog(
  propertyId: string,
  data: { sentOn: string; method?: "mail" | "hand_delivery" | "other"; note?: string },
): Promise<{ id: string }> {
  if (USE_MOCK) {
    await mockDelay();
    return { id: "mock-dm-log-1" };
  }
  return apiFetch<{ id: string }>(`/api/properties/${propertyId}/dm-logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

/** 送付記録の反響(4種)を手動記録する(PR-B)。売却DM由来の行(ブリッジ)は保存直後に
 * サーバが draft の証拠から再導出する(手動 no_response で消しても証拠があれば戻る)。 */
export async function updatePropertyDmLogReaction(
  propertyId: string,
  logId: string,
  data: {
    status: "no_response" | "replied" | "refused" | "undeliverable";
    reactedAt?: string;
    /** 省略=変更なし / null=消す / 文字列=上書き(GET はマスク値を返すため往復させない)。 */
    note?: string | null;
  },
): Promise<{
  id: string;
  reactionStatus: string;
  undeliverableLinked: boolean;
  undeliverableCleared: boolean;
}> {
  if (USE_MOCK) {
    await mockDelay();
    return {
      id: logId,
      reactionStatus: data.status,
      undeliverableLinked: false,
      undeliverableCleared: false,
    };
  }
  return apiFetch(`/api/properties/${propertyId}/dm-logs/${logId}/reaction`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

/** 送付記録の取消(記録ミスの訂正)。売却DM由来の行はサーバが 409 で拒否する。 */
export async function deletePropertyDmLog(
  propertyId: string,
  logId: string,
): Promise<{ deleted: boolean }> {
  if (USE_MOCK) {
    await mockDelay();
    return { deleted: true };
  }
  return apiFetch<{ deleted: boolean }>(
    `/api/properties/${propertyId}/dm-logs/${logId}`,
    { method: "DELETE" },
  );
}

// ---------- 謄本取得の事前確認(preflight・発注者要望 2026-08-08) ----------

import type { RegistryTarget } from "@/lib/registry-fetch/registry-target";

export interface RegistryPreflightFlags {
  propertyId: string;
  /** 登記状況が「取得済」か。 */
  registryObtained: boolean;
  /** 謄本PDF(未削除)が既に添付されているか。 */
  hasRegistryAttachment: boolean;
  /** 所有者が1名以上リンク済みか。 */
  hasOwners: boolean;
  /**
   * ⚠「何を取りに行くか(土地/建物)」。**参考情報ではなく買う対象そのもの**なので、
   * 上の3つとは扱いが違う。これが読めないうちは実行させない(fail closed)。
   */
  target: RegistryTarget;
}

/**
 * 謄本取得(単発・所在検索・一括)の前に「取得済み/添付あり/所有者あり」を確認する。
 * 3つの入口が同じサーバ判定を表示する(警告のみ・取得はブロックしない)。
 */
export async function fetchRegistryPreflight(
  propertyIds: string[],
): Promise<{ data: RegistryPreflightFlags[]; excluded: number }> {
  if (USE_MOCK) {
    await mockDelay();
    return {
      data: propertyIds.map((propertyId) => ({
        propertyId,
        registryObtained: false,
        hasRegistryAttachment: false,
        hasOwners: false,
        target: { kind: "none" as const, mismatchWarning: null },
      })),
      excluded: 0,
    };
  }
  return apiFetch<{ data: RegistryPreflightFlags[]; excluded: number }>(
    "/api/registry-fetch/preflight",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ propertyIds }),
    },
  );
}
