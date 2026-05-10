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

export const USE_MOCK = process.env.NEXT_PUBLIC_USE_MOCK === "true";

// Small delay to simulate network latency
const mockDelay = () => new Promise((r) => setTimeout(r, 200));

// ---------- Generic fetcher ----------

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error?.message ?? `Error: ${res.status}`);
  }
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

export async function fetchPropertyDetail(id: string) {
  if (USE_MOCK) {
    await mockDelay();
    const property = MOCK_PROPERTIES.find((p) => p.id === id);
    if (!property) throw new Error("物件が見つかりません");
    return property;
  }
  return apiFetch<(typeof MOCK_PROPERTIES)[0]>(`/api/properties/${id}`);
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
    return { data: MOCK_CANDIDATES };
  }
  return apiFetch<{ data: typeof MOCK_CANDIDATES }>(
    `/api/properties/${propertyId}/candidates`,
  );
}

// ---------- Quality Check ----------

export async function fetchQualityCheck() {
  if (USE_MOCK) {
    await mockDelay();
    const issues = MOCK_QUALITY_ISSUES;
    return {
      data: issues,
      summary: {
        total: issues.length,
        errors: issues.filter((i) => i.severity === "error").length,
        warnings: issues.filter((i) => i.severity === "warning").length,
        info: issues.filter((i) => i.severity === "info").length,
        propertiesChecked: MOCK_PROPERTIES.length,
      },
    };
  }
  return apiFetch<{ data: typeof MOCK_QUALITY_ISSUES; summary: unknown }>(
    "/api/properties/quality-check",
  );
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

export async function fetchImportJobDetail(jobId: string) {
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
  return apiFetch(`/api/import/jobs/${jobId}`);
}

// processing のまま残っているスタックジョブの一覧。
export interface StuckImportJob {
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

export interface RollbackResponse {
  alreadyRolledBack: boolean;
  eligible: boolean;
  ineligibleReason?: string;
  summary: {
    deletable: number;
    restorable: number;
    blocked: number;
    skipped: number;
  };
  blockedDetails: RollbackBlockedDetail[];
  executed: boolean;
  deletedCount?: number;
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
  receptionFileType: { type: string; label: string | null; error: string | null };
  ownerFileType: { type: string; label: string | null; error: string | null };
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
  receptionFileType: { type: string; label: string | null; error: string | null };
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

/** テキスト貼り付けモード (後方互換) */
export async function importRegistryPdf(
  text: string,
  propertyId?: string | null,
  fileName?: string,
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
    body: JSON.stringify({ text, propertyId, fileName }),
  });
}

/** PDF ファイル送信モード (サーバー側テキスト抽出) */
export async function importRegistryPdfFile(
  file: File,
  propertyId?: string | null,
  fileName?: string,
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

/** テキスト貼り付けプレビュー専用 (DB書き込みなし) */
export async function parseRegistryPdfText(text: string, fileName?: string) {
  if (USE_MOCK) {
    await mockDelay();
    return {
      fileName: fileName ?? "paste.txt",
      extractedTextLength: text.length,
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
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error?.message ?? `Error: ${res.status}`);
  }
  return res.json();
}

// ---------- Property Create ----------

export async function createProperty(data: {
  propertyType: string;
  address: string;
  lotNumber?: string | null;
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

// ---------- Audit Logs ----------

export async function fetchAuditLogs() {
  if (USE_MOCK) {
    await mockDelay();
    return { data: MOCK_AUDIT_LOGS };
  }
  return apiFetch<{ data: typeof MOCK_AUDIT_LOGS }>("/api/admin/audit-logs");
}
