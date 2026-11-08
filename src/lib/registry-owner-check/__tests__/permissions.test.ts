import { describe, it, expect } from "vitest";

import { findMissingRegistryOwnerReviewPerm } from "@/lib/registry-owner-check/permissions";

const g = (resource: string, action: string) => ({ resource, action, granted: true });
const viewer = [g("property", "read"), g("owner", "read"), g("owner_name", "full"), g("registry_pdf", "preview")];
const admin = [
  ...viewer,
  g("owner", "write"),
  g("user_management", "read"),
  g("property", "write"),
  g("import", "write"),
];

describe("謄本の名義の確認の権限", () => {
  it("見る: 4つそろえば見られる", () => {
    expect(findMissingRegistryOwnerReviewPerm(viewer, "view")).toBeNull();
  });

  it("氏名が伏せ字の人は見られない(比べられない)", () => {
    const masked = viewer.map((p) => (p.resource === "owner_name" ? g("owner_name", "masked") : p));
    expect(findMissingRegistryOwnerReviewPerm(masked, "view")).toMatch(/氏名/);
  });

  it("謄本を見られない人は見られない", () => {
    expect(findMissingRegistryOwnerReviewPerm(viewer.filter((p) => p.resource !== "registry_pdf"), "view")).toMatch(/謄本/);
  });

  it("このままでよい: 所有者を編集できる人まで", () => {
    expect(findMissingRegistryOwnerReviewPerm(viewer, "keep")).toMatch(/所有者を編集/);
    expect(findMissingRegistryOwnerReviewPerm([...viewer, g("owner", "write")], "keep")).toBeNull();
  });

  it("謄本の名義に直す: 管理者だけ", () => {
    expect(findMissingRegistryOwnerReviewPerm([...viewer, g("owner", "write"), g("property", "write"), g("import", "write")], "replace")).toMatch(/管理者/);
    expect(findMissingRegistryOwnerReviewPerm(admin, "replace")).toBeNull();
    expect(findMissingRegistryOwnerReviewPerm(admin.filter((p) => p.resource !== "import"), "replace")).toMatch(/取込/);
  });

  it("全件を比べる: 管理者だけ", () => {
    expect(findMissingRegistryOwnerReviewPerm(viewer, "run")).toMatch(/管理者/);
    expect(findMissingRegistryOwnerReviewPerm([...viewer, g("user_management", "read")], "run")).toBeNull();
  });
});
