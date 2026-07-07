import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = readFileSync(
  path.resolve(process.cwd(), "src/app/(dashboard)/admin/registry-settings/page.tsx"),
  "utf-8",
);

describe("registry-settings page (source wiring)", () => {
  it("fetch/update を使う", () => {
    expect(src).toContain("fetchRegistrySettings");
    expect(src).toContain("updateRegistrySettings");
  });
  it("秘匿値は password 入力・値を出さない(設定済 placeholder)", () => {
    expect(src).toContain('type="password"');
    expect(src).toContain("設定済");
  });
  it("暗号化未設定の警告・dark 対応", () => {
    expect(src).toContain("encryptionConfigured");
    expect(src).toContain("dark:bg-gray-900");
  });
});
