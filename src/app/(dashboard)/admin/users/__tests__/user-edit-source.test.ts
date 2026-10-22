import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// 2026-10-23 発注者決定: 一覧の削除ボタンを外し、編集(名前・メール・役割)と
// 「無効にした人と同じメールなら有効に戻す」を足す。失敗の理由は画面に出す。
const dir = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(dir, "..", "page.tsx"), "utf8");

describe("ユーザー管理の一覧(削除ボタンを外す・編集を足す)", () => {
  it("一覧に削除ボタンが無い", () => {
    expect(page).not.toMatch(/title="削除"/);
    expect(page).not.toContain("削除不可");
    expect(page).not.toContain('setActionType("delete")');
    expect(page).not.toContain('method: "DELETE"');
  });

  it("一覧に「編集」ボタンがあり、名前・メール・役割を直す小窓を開く", () => {
    expect(page).toMatch(/title="編集"/);
    expect(page).toContain("function EditUserModal");
    expect(page).toMatch(/EditUserModal[\s\S]*method: "PATCH"/);
  });

  it("新規作成で無効にした人と同じメールなら、有効に戻す案内とボタンがある", () => {
    expect(page).toContain("INACTIVE_USER_EXISTS");
    expect(page).toContain("有効に戻す");
  });

  it("有効に戻すのは1回の書き込み(PATCH に newPassword)で、reset-password を別に呼ばない", () => {
    const fn = page.slice(page.indexOf("const handleReactivate"), page.indexOf("const setField"));
    expect(fn).toContain("newPassword: form.password");
    expect(fn).not.toContain("reset-password");
  });

  it("失敗の理由は apiErrorMessage で読む(data.message / e.message を直接読まない)", () => {
    expect(page).toContain("apiErrorMessage");
    expect(page).not.toMatch(/\b(e|data|json)\.message \?\?/);
    expect(page).not.toMatch(/throw new Error\("失敗"\)/);
  });
});
