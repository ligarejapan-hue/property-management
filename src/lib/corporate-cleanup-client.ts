// 法人番号 混入除去 API の薄い client ラッパ(api-client.ts を編集しないため独立)。
export interface CorporateCleanupPreview {
  action: "none" | "cleanup" | "manual";
  manualReason: "multi" | "name_would_be_empty" | null;
  importAction: "none" | "save" | "noop" | "multi" | "conflict";
  detectedIn: Array<"name" | "address" | "note">;
  changedFields: Array<"name" | "address" | "note" | "corporateNumber">;
  version: number;
  before: { nameMasked: string | null; addressMasked: string | null; noteMasked: string | null };
  after: { nameMasked: string | null; addressMasked: string | null; noteMasked: string | null };
  corporateNumberToSetMasked: string | null;
}
export interface CorporateCleanupApplyBody {
  version: number;
  apply: { name: boolean; address: boolean; note: boolean; corporateNumber: boolean };
}
export class CorporateCleanupClientError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

async function parseError(res: Response): Promise<never> {
  let code = "ERROR", message = "エラーが発生しました";
  try { const b = await res.json(); code = b?.error?.code ?? code; message = b?.error?.message ?? message; } catch { /* noop */ }
  throw new CorporateCleanupClientError(code, message);
}

export async function fetchCorporateCleanupPreview(ownerId: string): Promise<CorporateCleanupPreview> {
  const res = await fetch(`/api/owners/${ownerId}/corporate-cleanup`, { method: "GET" });
  if (!res.ok) return parseError(res);
  const body = await res.json();
  return body.cleanup as CorporateCleanupPreview;
}

export async function applyCorporateCleanup(
  ownerId: string,
  body: CorporateCleanupApplyBody,
): Promise<{ ok: true; owner: { id: string; version: number } }> {
  const res = await fetch(`/api/owners/${ownerId}/corporate-cleanup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return parseError(res);
  return res.json();
}
