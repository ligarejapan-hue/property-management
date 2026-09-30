/**
 * 通知 段階1 の配線を source で固定する(env=node・jsdom を使わない方針のため)。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(resolve(__dirname, "../../../", p), "utf-8");

describe("ログアウトの経路", () => {
  it("アプリのログアウトはすべて通知の後片付けを通す(next-auth の signOut を直接呼ばない)", () => {
    for (const p of [
      "components/layout/dashboard-layout.tsx",
      "components/auth/idle-session-guard.tsx",
      "app/(dashboard)/admin/change-password/page.tsx",
    ]) {
      const src = read(p);
      expect(src, p).not.toMatch(/\bsignOut\(\s*\{/);
      expect(src, p).toContain("signOutWithNotificationCleanup");
    }
  });
});

describe("自動ログオフの予告ダイアログ", () => {
  it("「ログアウトする」への操作は活動(延長)に数えない(押した瞬間にダイアログが消えない)", () => {
    expect(read("components/auth/idle-logout-dialog.tsx")).toMatch(/onClick=\{onLogout\}\s+data-idle-logout-action/);
    expect(read("components/auth/idle-session-guard.tsx")).toMatch(
      /const markActivity = \(e\?: Event\) => \{[\s\S]{0,300}closest\("\[data-idle-logout-action\]"\)\) return;/,
    );
  });
});

describe("編集権限の知らせ", () => {
  it("戻った直後の合図で外れたと分かった場合も、戻ったときの知らせを出す", () => {
    const src = read("components/notifications/edit-lock-notices.tsx");
    expect(src).toContain("returnedAtRef.current = Date.now()");
    expect(src).toMatch(/justReturned[\s\S]*toast\(/);
  });

  it("物件・所有者の編集画面とも、保存前の入力の有無を渡す", () => {
    expect(read("components/properties/property-edit-form.tsx")).toContain("hasUnsavedInput={hasUnsavedInput}");
    expect(read("app/(dashboard)/properties/[id]/page.tsx")).toContain("hasUnsavedInput={hasUnsavedOwnerInput}");
  });
});
