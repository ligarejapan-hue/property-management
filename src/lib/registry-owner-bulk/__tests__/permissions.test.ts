/**
 * まとめて反映に必要な権限。
 *
 * ⚠1件ずつのボタンと同じ線(取込の権限+所有者の編集+氏名・住所の項目権限)に加えて、
 *   **管理者のみ**にする(他人の担当物件もまとめて触るため)。
 * ⚠住所の項目権限は、まとめて反映では**無条件で必須**にする。1件ずつは「その謄本に
 *   住所があるときだけ」だが、まとめて反映は中身を見る前に走り出すので、
 *   途中で住所つきの謄本に当たって半分だけ失敗する、を避ける。
 */
import { describe, it, expect } from "vitest";

import { findMissingRegistryOwnerApplyPerm } from "@/lib/registry-owner-bulk/permissions";

const ALL = [
  { resource: "property", action: "read", granted: true },
  { resource: "registry_pdf", action: "preview", granted: true },
  { resource: "import", action: "write", granted: true },
  { resource: "owner", action: "write", granted: true },
  { resource: "owner_name", action: "edit", granted: true },
  { resource: "owner_address", action: "full", granted: true },
];

describe("まとめて反映の権限", () => {
  it("管理者ですべて揃っていれば通る", () => {
    expect(findMissingRegistryOwnerApplyPerm("admin", ALL)).toBeNull();
  });

  it("⚠管理者以外は通さない", () => {
    expect(findMissingRegistryOwnerApplyPerm("office_staff", ALL)).toBe("role");
    expect(findMissingRegistryOwnerApplyPerm("field_staff", ALL)).toBe("role");
  });

  it("⚠物件を見る権限が無ければ通さない（謄本の中身を読む操作なので閲覧側も要る）", () => {
    expect(
      findMissingRegistryOwnerApplyPerm(
        "admin",
        ALL.filter((p) => p.resource !== "property"),
      ),
    ).toBe("property");
  });

  it("⚠謄本を見る権限が無ければ通さない（止められた人がまとめて読めてしまう）", () => {
    expect(
      findMissingRegistryOwnerApplyPerm(
        "admin",
        ALL.filter((p) => p.resource !== "registry_pdf"),
      ),
    ).toBe("registry_pdf");
  });

  it("取込の権限が無ければ通さない", () => {
    expect(
      findMissingRegistryOwnerApplyPerm(
        "admin",
        ALL.filter((p) => p.resource !== "import"),
      ),
    ).toBe("import");
  });

  it("所有者の編集権限が無ければ通さない", () => {
    expect(
      findMissingRegistryOwnerApplyPerm(
        "admin",
        ALL.filter((p) => p.resource !== "owner"),
      ),
    ).toBe("owner");
  });

  it("⚠氏名・住所の項目ごとの権限が無ければ通さない", () => {
    expect(
      findMissingRegistryOwnerApplyPerm(
        "admin",
        ALL.filter((p) => p.resource !== "owner_name"),
      ),
    ).toBe("owner_name");
    expect(
      findMissingRegistryOwnerApplyPerm(
        "admin",
        ALL.filter((p) => p.resource !== "owner_address"),
      ),
    ).toBe("owner_address");
  });

  it("権限が granted=false なら無いものとして扱う", () => {
    expect(
      findMissingRegistryOwnerApplyPerm(
        "admin",
        ALL.map((p) =>
          p.resource === "owner" ? { ...p, granted: false } : p,
        ),
      ),
    ).toBe("owner");
  });

  it("⚠閲覧だけの項目権限では通さない（read は書き込みではない）", () => {
    expect(
      findMissingRegistryOwnerApplyPerm(
        "admin",
        ALL.map((p) =>
          p.resource === "owner_name" ? { ...p, action: "read" } : p,
        ),
      ),
    ).toBe("owner_name");
  });
});
