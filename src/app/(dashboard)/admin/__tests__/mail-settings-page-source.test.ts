import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const page = readFileSync(path.join(process.cwd(), "src/app/(dashboard)/admin/mail-settings/page.tsx"), "utf8");
const sidebar = readFileSync(path.join(process.cwd(), "src/components/layout/sidebar-model.tsx"), "utf8");

describe("メール送信設定の画面", () => {
  it("パスワード欄は type=password・値を画面に戻さない(placeholder で設定済みを示す)", () => {
    expect(page).toContain('type="password"');
    expect(page).toContain("設定済み(変更する場合のみ入力)");
    expect(page).not.toMatch(/value=\{[^}]*smtpPass/);
  });
  it("テスト送信・通知先未設定の案内・Xserver の既定値の説明", () => {
    expect(page).toContain("テスト送信");
    expect(page).toContain("通知先が未設定です");
    expect(page).toContain("465");
  });
  it("サイドバー: DM グループに admin 限定で出す", () => {
    expect(sidebar).toMatch(/label:\s*"メール送信設定",\s*href:\s*"\/admin\/mail-settings"[^}]*minRole:\s*"admin"/);
  });
  it("生の h1 を使わない", () => {
    expect(page).not.toContain("<h1");
  });
});
