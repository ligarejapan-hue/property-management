// アーカイブ済みの所有者の一覧・戻す(2026-11-24)の薄い client ラッパ。
import type { ArchivedOwnersResponse } from "./owner-archived";

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const b = await res.json();
    return b?.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

export async function fetchArchivedOwners(page: number): Promise<ArchivedOwnersResponse> {
  const res = await fetch(`/api/admin/owners/correction/archived?page=${page}`, { method: "GET" });
  if (!res.ok) throw new Error(await errorMessage(res, "一覧を読めませんでした"));
  return res.json();
}

export async function unarchiveOwner(
  ownerId: string,
  version: number,
): Promise<{ executed: true; id: string; version: number }> {
  const res = await fetch(`/api/admin/owners/${ownerId}/correction/unarchive`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version }),
  });
  if (!res.ok) throw new Error(await errorMessage(res, "戻せませんでした"));
  return res.json();
}
