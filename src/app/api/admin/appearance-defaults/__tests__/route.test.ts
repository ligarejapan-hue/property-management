/**
 * 見た目の設定 段階4(2026-10-31): 会社の標準(色・文字・配置)と選べる色テーマを管理者が保存する。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", async () => (await import("@/lib/__tests__/agent-inquiry-route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("@/lib/__tests__/agent-inquiry-route-mocks")).apiHelpersMock());
const { writeAuditLog, saveCompanyAppearance } = vi.hoisted(() => ({ writeAuditLog: vi.fn(), saveCompanyAppearance: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
vi.mock("@/lib/appearance/server", () => ({ saveCompanyAppearance }));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { jsonRequest as json } from "@/lib/__tests__/agent-inquiry-route-mocks";
import { PUT } from "../route";

type Fn = ReturnType<typeof vi.fn>;
const ADMIN = [{ resource: "user_management", action: "write", granted: true }];
const body = { theme: "navy", density: null, layout: "top", allowedThemes: ["standard", "navy"] };

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u-admin", role: "admin" });
  (getUserPermissions as Fn).mockResolvedValue(ADMIN);
});

describe("PUT /api/admin/appearance-defaults", () => {
  it("管理者でなければ 403(保存しない)", async () => {
    (getUserPermissions as Fn).mockResolvedValue([{ resource: "property", action: "write", granted: true }]);
    expect((await PUT(json("PUT", body))).status).toBe(403);
    expect(saveCompanyAppearance).not.toHaveBeenCalled();
  });
  it("保存して監査ログに残す(中身は項目の名前と値だけ=個人情報なし)", async () => {
    const res = await PUT(json("PUT", body));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(saveCompanyAppearance).toHaveBeenCalledWith(body);
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u-admin", action: "appearance_defaults_update", targetTable: "system_settings", detail: body }),
    );
  });
  it.each([
    [{ ...body, theme: "purple" }],
    [{ ...body, allowedThemes: [] }],
    [{ ...body, allowedThemes: ["standard"] }],
    [{ ...body, extra: true }],
  ])("不正な値は保存しない(422): %j", async (b) => {
    expect((await PUT(json("PUT", b))).status).toBe(422);
    expect(saveCompanyAppearance).not.toHaveBeenCalled();
  });
});
