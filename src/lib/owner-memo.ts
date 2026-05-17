import type { PermissionEntry } from "@/lib/api-helpers";
import { hasPermission, hasExplicitWritePerm, getOwnerFieldLevel } from "@/lib/permissions";

export const OWNER_MEMO_BODY_MAX_LENGTH = 5000;

/**
 * 本文に対する可視性。owner_note displayLevel から導出する。
 * - hidden        : 一覧自体を空にする（UI破綻防止のため 403 ではなく空配列）
 * - meta_only     : メモのメタ情報（id/createdAt/creator）は返すが body は空文字に伏せる
 * - visible       : body そのまま返却
 */
export type OwnerMemoBodyVisibility = "hidden" | "meta_only" | "visible";

/**
 * GET /api/owners/:id/memos で返す body の見せ方を決める。
 * owner_note の displayLevel をそのまま流用する（独自の resource を増やさない）。
 */
export function resolveOwnerMemoBodyVisibility(
  perms: PermissionEntry[],
): OwnerMemoBodyVisibility {
  const level = getOwnerFieldLevel(perms, "owner_note");
  if (level === "hidden") return "hidden";
  if (level === "masked" || level === "partial") return "meta_only";
  return "visible";
}

/**
 * POST /api/owners/:id/memos の権限ゲート。
 * owner:write（テーブル単位） かつ owner_note の full/edit（フィールド単位）を要求する。
 * PR #21 で導入した field-level write guard と同方針。
 */
export function canCreateOwnerMemo(perms: PermissionEntry[]): boolean {
  if (!hasPermission(perms, "owner", "write")) return false;
  if (!hasExplicitWritePerm(perms, "owner_note")) return false;
  return true;
}

/**
 * body のバリデーション結果。エラーメッセージは API レスポンスに転用できる粒度で返す。
 */
export type OwnerMemoBodyValidation =
  | { ok: true; body: string }
  | { ok: false; reason: "empty" | "too_long" };

export function validateOwnerMemoBody(input: unknown): OwnerMemoBodyValidation {
  if (typeof input !== "string") return { ok: false, reason: "empty" };
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  if (trimmed.length > OWNER_MEMO_BODY_MAX_LENGTH) return { ok: false, reason: "too_long" };
  return { ok: true, body: trimmed };
}

/**
 * 担当者表示名のフォールバック。
 * name → email → "不明な担当者"
 */
export function formatMemoCreatorName(
  creator: { name?: string | null; email?: string | null } | null | undefined,
): string {
  if (!creator) return "不明な担当者";
  if (creator.name && creator.name.trim().length > 0) return creator.name;
  if (creator.email && creator.email.trim().length > 0) return creator.email;
  return "不明な担当者";
}
