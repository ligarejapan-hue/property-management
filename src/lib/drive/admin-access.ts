/**
 * Google ドライブ連携の管理 API の共通部分: 管理者の確認と、ドライブ側の失敗を API の誤りに直す。
 */
import { NextResponse } from "next/server";
import { ApiError, getApiSession, getUserPermissions, type ApiSession } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { DriveAuthError } from "./oauth";
import { DriveApiError } from "./client";

/** 接続・紐づけは管理者(user_management:write)だけ。発注者のドライブ全体を触れる高リスクの設定のため。 */
export async function requireDriveAdmin(): Promise<ApiSession> {
  const session = await getApiSession();
  const perms = await getUserPermissions(session.id);
  if (!hasPermission(perms, "user_management", "write")) {
    throw new ApiError(403, "ドライブ連携の設定は管理者だけが行えます", "FORBIDDEN");
  }
  return session;
}

/** ドライブ側の失敗を、画面に出せる言葉の ApiError に(トークンや名前は含めない)。 */
export function toDriveApiError(e: unknown): unknown {
  if (e instanceof DriveAuthError) {
    if (e.code === "not_connected") return new ApiError(409, "Google ドライブに接続されていません", "DRIVE_NOT_CONNECTED");
    if (e.code === "not_configured") return new ApiError(503, "Google ドライブのクライアント設定(app.env)がありません", "DRIVE_NOT_CONFIGURED");
    if (e.needsReconnect) return new ApiError(409, "Google の認可が切れています。「Google に接続」をやり直してください", "DRIVE_RECONNECT");
    return new ApiError(502, "Google の認可サーバーとのやりとりに失敗しました", "DRIVE_AUTH_FAILED");
  }
  if (e instanceof DriveApiError) {
    if (e.needsReconnect) return new ApiError(409, "Google の認可が切れています。「Google に接続」をやり直してください", "DRIVE_RECONNECT");
    if (e.status === 403) return new ApiError(502, "Google ドライブが拒否しました(権限の範囲を確かめてください)", "DRIVE_FORBIDDEN");
    return new ApiError(502, "Google ドライブの応答が異常でした", "DRIVE_API_FAILED");
  }
  return e;
}

/** 画面(管理 › ドライブ連携)へ戻す。Location は相対(nginx の後ろでも入口の名前に依存しない)。 */
export function redirectToDriveAdmin(query: Record<string, string>): NextResponse {
  const qs = new URLSearchParams(query).toString();
  return new NextResponse(null, {
    status: 302,
    headers: { Location: `/admin/drive${qs ? `?${qs}` : ""}`, "Cache-Control": "no-store" },
  });
}
