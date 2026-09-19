import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (p: string) => readFileSync(path.resolve(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

describe("同意文の管理者設定", () => {
  const route = read("src/app/api/admin/sale-dm-settings/route.ts");
  const page = read("src/app/(dashboard)/admin/sale-dm-settings/page.tsx");
  it("API は privacyText を 2000字まで受け、返す。監査は項目名のみ", () => {
    expect(route).toMatch(/privacyText:\s*z\.string\(\)\.trim\(\)\.max\(2000\)\.optional\(\)/);
    expect(route).toContain("privacyText: row?.privacyText ?? null");
    expect(route).toContain('changed.push("privacyText")');
  });
  it("画面に入力欄があり、空ならひな形が使われる旨を出す", () => {
    expect(page).toContain("個人情報の取扱い文");
    expect(page).toContain("<textarea");
    expect(page).toContain("DEFAULT_PRIVACY_TEXT");
  });
});
