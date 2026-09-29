/**
 * 後片付けの「片付け済み」判定(通知 段階1・設計書 §4.5)。
 * node には Service Worker・Notification が無い=初めから OS の通知を出せない環境として扱う。
 */
import { describe, expect, it } from "vitest";
import { cleanupNotifications, notificationSupport, showOsNotification } from "../sw-client";

describe("OS の通知を出せない環境", () => {
  it("非対応として扱い、後片付けは片付け済み(ログインを止めない)", async () => {
    expect(notificationSupport()).toBe("unsupported");
    await expect(cleanupNotifications()).resolves.toBe(true);
  });

  it("OS の通知は出さない", async () => {
    await expect(showOsNotification({ gen: 0, title: "t", body: "b", tag: "x" })).resolves.toBe(false);
  });
});
