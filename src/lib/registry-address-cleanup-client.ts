// DQ-03: 住所の登記文字列 cleanup の薄い client ラッパ（api-client.ts を編集しないため独立）。
import type { RegistryStringType } from "./registry-address-cleanup";

export type RegistryAddressCandidateFilter = "all" | "cleanup" | "manual";

export interface RegistryAddressCandidateRow {
  ownerId: string;
  ownerNameMasked: string | null;
  addressBeforeMasked: string | null;
  addressAfterMasked: string | null;
  action: "cleanup" | "manual";
  detectedTypes: RegistryStringType[];
  removableTypes: RegistryStringType[];
  auditOnlyTypes: RegistryStringType[];
  manualReviewRequired: boolean;
  version: number;
  detailUrl: string;
}

export interface RegistryAddressCandidatesResponse {
  type: RegistryAddressCandidateFilter;
  candidates: RegistryAddressCandidateRow[];
  summary: { total: number; cleanup: number; manual: number };
  hasNextPage: boolean;
  nextCursor: string | null;
  truncated: boolean;
}

export class RegistryAddressCleanupClientError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function parseError(res: Response): Promise<never> {
  let code = "ERROR";
  let message = "エラーが発生しました";
  try {
    const b = await res.json();
    code = b?.error?.code ?? code;
    message = b?.error?.message ?? message;
  } catch {
    /* noop */
  }
  throw new RegistryAddressCleanupClientError(code, message);
}

export async function fetchRegistryAddressCandidates(
  type: RegistryAddressCandidateFilter,
  opts: { cursor?: string } = {},
): Promise<RegistryAddressCandidatesResponse> {
  const sp = new URLSearchParams();
  sp.set("type", type);
  if (opts.cursor) sp.set("cursor", opts.cursor);
  const res = await fetch(
    `/api/admin/owners/correction/registry-address-candidates?${sp.toString()}`,
    { method: "GET" },
  );
  if (!res.ok) return parseError(res);
  return res.json();
}

export async function applyRegistryAddressCleanup(
  ownerId: string,
  body: { version: number; apply: { address: boolean } },
): Promise<{ ok: true; owner: { id: string; version: number } }> {
  const res = await fetch(
    `/api/admin/owners/${ownerId}/registry-address-cleanup`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) return parseError(res);
  return res.json();
}
