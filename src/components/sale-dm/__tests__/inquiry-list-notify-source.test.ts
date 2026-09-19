import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const root = process.cwd();
const list = readFileSync(path.join(root, "src/components/sale-dm/inquiry-list.tsx"), "utf8");
const page = readFileSync(path.join(root, "src/app/(dashboard)/properties/sale-dm/inquiries/page.tsx"), "utf8");
const sidebar = readFileSync(path.join(root, "src/components/layout/sidebar-model.tsx"), "utf8");

describe("査定の申込 画面", () => {
  it("通知の失敗と再送・通知先未設定の案内", () => {
    expect(list).toContain("通知できていません");
    expect(list).toContain("再送");
    expect(list).toContain("resendSaleDmInquiryNotify");
    expect(list).toContain("通知先が未設定です");
  });
  it("横断モードとリンクの focus", () => {
    expect(page).toContain('mode="all"');
    expect(page).toMatch(/searchParams|useSearchParams/);
    expect(page).toContain("focus");
  });
  it("画面保護の印を保つ", () => {
    expect(list).toContain('data-pii-protected');
  });
  it("サイドバー: DM グループに office_staff で「査定の申込」", () => {
    expect(sidebar).toMatch(/label:\s*"査定の申込",\s*href:\s*"\/properties\/sale-dm\/inquiries"[^}]*minRole:\s*"office_staff"/);
  });
});
