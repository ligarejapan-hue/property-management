"use client";

/**
 * ログアウトの前に、その端末の通知を片付ける(共用 PC 対策・設計書 §4.5)。
 * 片付けに失敗してもログアウト自体は止めない(ログイン画面でもう一度確かめる)。
 */
import { signOut } from "next-auth/react";
import { clearNoticeStorage } from "./notice-store";
import { cleanupNotifications, unregisterPushDevice } from "./sw-client";

export async function signOutWithNotificationCleanup(callbackUrl = "/login"): Promise<void> {
  clearNoticeStorage();
  // 段階4a: この端末への送信をサーバー側で止める(ログインしている間に呼ぶ必要がある)。
  await unregisterPushDevice();
  try {
    await cleanupNotifications();
  } catch {
    /* ログイン画面で再確認する */
  }
  await signOut({ callbackUrl });
}
