import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = readFileSync(
  path.resolve(process.cwd(), "src/components/layout/sidebar-model.tsx"),
  "utf-8",
);

describe("sidebar: registry settings nav", () => {
  it("⚠謄本取得の資格情報はメニューから廃止(発注者決定 2026-08-24)", () => {
    // 謄本は共通アカウントから取る運用のため、画面ごと撤去した。
    // 取得機能の本体(env 経由の資格情報の解決)は残っている=挙動は不変。
    expect(src).not.toMatch(/\/admin\/registry-settings/);
    expect(src).not.toContain("謄本取得の資格情報");
  });
});
