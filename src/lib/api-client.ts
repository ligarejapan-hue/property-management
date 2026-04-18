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

export async function fetchImportJobs() {
  if (USE_MOCK) {
    await mockDelay();
    return { data: MOCK_IMPORT_JOBS };
  }
  return apiFetch<{ data: typeof MOCK_IMPORT_JOBS }>("/api/import/jobs");
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

export async function importCsv(fileName: string, csvText: string, columnMapping?: Record<string, string>) {
  if (USE_MOCK) {
    await mockDelay();
    const rows = csvText.split("\n").length - 1;
    return {
      jobId: "ij-mock-" + Date.now(),
      totalRows: rows,
      successCount: Math.max(0, rows - 1),
      errorCount: 0,
      needsReviewCount: 1,
      parseErrors: [],
    };
  }
  return apiFetch("/api/import/csv", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileName, csvText, columnMapping }),
  });
}

export async function previewCsvDuplicates(
  csvText: string,
  columnMapping?: Record<string, string>,
) {
  if (USE_MOCK) {
    await mockDelay();
    return { totalRows: 0, validRows: 0, errorRows: 0, duplicateCount: 0, duplicates: [] };
  }
  return apiFetch("/api/import/csv/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ csvText, columnMapping }),
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
  liquefactionRiskLevel: string | null;
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
      liquefactionRiskLevel: null,
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
      sedimentRiskCategory: null, liquefactionRiskLevel: null,
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
      sedimentRiskCategory: null, liquefactionRiskLevel: null,
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
      },
    };
  }
  const formData = new FormData();
  formData.append("file", file);
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
