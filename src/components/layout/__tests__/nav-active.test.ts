import { describe, it, expect } from "vitest";
import { isNavItemActive } from "../sidebar-model";

describe("isNavItemActive(現在地ハイライト)", () => {
  it("物件一覧: 一覧そのものと物件詳細で点灯する", () => {
    expect(isNavItemActive("/properties", "/properties")).toBe(true);
    expect(isNavItemActive("/properties", "/properties/abc123")).toBe(true);
    expect(isNavItemActive("/properties", "/properties/abc123/dm-logs")).toBe(true);
    expect(isNavItemActive("/properties", "/properties/abc123/sales-sheets")).toBe(true);
  });

  it("物件一覧: 品質チェック/売却DMでは点灯しない(C-5 現在地ズレ修正)", () => {
    expect(isNavItemActive("/properties", "/properties/quality-check")).toBe(false);
    expect(isNavItemActive("/properties", "/properties/sale-dm")).toBe(false);
    expect(isNavItemActive("/properties", "/properties/sale-dm/camp1")).toBe(false);
  });

  it("取込: 完全一致のみ(配下では点灯しない)", () => {
    expect(isNavItemActive("/import", "/import")).toBe(true);
    expect(isNavItemActive("/import", "/import/registry-pdf")).toBe(false);
  });

  it("一般項目: 完全一致か配下で点灯", () => {
    expect(isNavItemActive("/buildings", "/buildings")).toBe(true);
    expect(isNavItemActive("/buildings", "/buildings/xyz")).toBe(true);
    expect(isNavItemActive("/admin/users", "/admin/users")).toBe(true);
    expect(isNavItemActive("/admin/users", "/admin/templates")).toBe(false);
  });

  it("前方一致の誤爆を避ける(/home が /home-x を拾わない)", () => {
    expect(isNavItemActive("/home", "/home")).toBe(true);
    expect(isNavItemActive("/home", "/home-dashboard")).toBe(false);
  });
});
