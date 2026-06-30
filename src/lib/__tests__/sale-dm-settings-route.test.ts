import { vi } from "vitest";
vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response { static json = (b: unknown, init?: ResponseInit) => Response.json(b, init); }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error { status: number; code: string; constructor(s: number, m: string, c = "ERROR") { super(m); this.status = s; this.code = c; } }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(), getUserPermissions: vi.fn(),
    parseJsonBody: vi.fn(async (r: Request) => { const t = await r.text(); return t ? JSON.parse(t) : {}; }),
    handleApiError: vi.fn((e: unknown) => {
      if (e instanceof MockApiError) return Response.json({ error: { message: e.message, code: e.code } }, { status: e.status });
      if (e !== null && typeof e === "object" && "issues" in e && Array.isArray((e as Record<string, unknown>).issues)) {
        return Response.json({ error: { code: "VALIDATION_ERROR" } }, { status: 422 });
      }
      return Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 });
    }),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ default: { saleDmConfig: { findUnique: vi.fn(), upsert: vi.fn() } } }));

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { decryptSecret } from "../sale-dm-letter/secret-crypto";
import { GET, PUT } from "../../app/api/admin/sale-dm-settings/route";

const pm = prismaMock as never as {
  saleDmConfig: { findUnique: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };
};
const admin = () => (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue([{ resource: "user_management", action: "write", granted: true }]);
const nonAdmin = () => (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue([{ resource: "user_management", action: "write", granted: false }]);
const putReq = (b: unknown) => new Request("http://x", { method: "PUT", body: JSON.stringify(b) }) as never;
const ENV = process.env;
const MKEY = crypto.randomBytes(32).toString("base64");

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...ENV, SALE_DM_SETTINGS_ENC_KEY: MKEY };
  (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1" });
  pm.saleDmConfig.findUnique.mockResolvedValue(null);
  pm.saleDmConfig.upsert.mockImplementation(async (args: { update: Record<string, unknown> }) => ({
    id: "singleton", provider: null, model: null, trackingBaseUrl: null, lpUrl: null,
    senderName: null, senderContact: null, anthropicApiKeyEnc: null, openaiApiKeyEnc: null,
    updatedAt: new Date(), ...args.update,
  }));
});
afterEach(() => { process.env = ENV; });

describe("GET /api/admin/sale-dm-settings", () => {
  it("admin で 200・キー値は返さず『設定済/未設定』のみ", async () => {
    admin();
    pm.saleDmConfig.findUnique.mockResolvedValue({
      id: "singleton", provider: "claude", model: null, trackingBaseUrl: "https://t.example.com",
      lpUrl: null, senderName: "X社", senderContact: "03", anthropicApiKeyEnc: "v1:iv:tag:ct", openaiApiKeyEnc: null, updatedAt: new Date(),
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.provider).toBe("claude");
    expect(json.data.hasAnthropicKey).toBe(true);
    expect(json.data.hasOpenaiKey).toBe(false);
    expect(json.data.encryptionConfigured).toBe(true);
    // 暗号文/キー値はレスポンスに含めない。
    expect(JSON.stringify(json.data)).not.toContain("v1:iv");
    expect(json.data.anthropicApiKey).toBeUndefined();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
  it("非adminは403", async () => {
    nonAdmin();
    expect((await GET()).status).toBe(403);
  });
});

describe("PUT /api/admin/sale-dm-settings", () => {
  it("APIキーを暗号化して保存・平文では保存せず・応答にもキー値を返さない", async () => {
    admin();
    const res = await PUT(putReq({ provider: "claude", anthropicApiKey: "sk-ant-very-secret" }));
    expect(res.status).toBe(200);
    const update = pm.saleDmConfig.upsert.mock.calls[0][0].update;
    expect(update.anthropicApiKeyEnc).toBeTruthy();
    expect(update.anthropicApiKeyEnc).not.toContain("sk-ant-very-secret"); // 平文を保存しない
    expect(decryptSecret(update.anthropicApiKeyEnc)).toBe("sk-ant-very-secret"); // 復号で戻る
    const json = await res.json();
    expect(JSON.stringify(json)).not.toContain("sk-ant-very-secret"); // 応答にキー値なし
    expect(json.data.hasAnthropicKey).toBe(true);
  });
  it("暗号化マスターキー未設定でAPIキー保存は503・upsertしない", async () => {
    admin();
    delete process.env.SALE_DM_SETTINGS_ENC_KEY;
    const res = await PUT(putReq({ anthropicApiKey: "sk-x" }));
    expect(res.status).toBe(503);
    expect(pm.saleDmConfig.upsert).not.toHaveBeenCalled();
  });
  it("APIキー空文字はクリア(enc=null)", async () => {
    admin();
    await PUT(putReq({ anthropicApiKey: "" }));
    expect(pm.saleDmConfig.upsert.mock.calls[0][0].update.anthropicApiKeyEnc).toBeNull();
  });
  it("APIキー未指定はキー列に触れない(部分更新で既存キーを消さない)", async () => {
    admin();
    await PUT(putReq({ provider: "openai" }));
    const update = pm.saleDmConfig.upsert.mock.calls[0][0].update;
    expect("anthropicApiKeyEnc" in update).toBe(false);
    expect("openaiApiKeyEnc" in update).toBe(false);
    expect(update.provider).toBe("openai");
  });
  it("非絶対URL(lpUrl)は422", async () => {
    admin();
    expect((await PUT(putReq({ lpUrl: "relative/path" }))).status).toBe(422);
  });
  it("空文字URLはクリア(null)として受理", async () => {
    admin();
    await PUT(putReq({ lpUrl: "" }));
    expect(pm.saleDmConfig.upsert.mock.calls[0][0].update.lpUrl).toBeNull();
  });
  it("非adminは403・保存しない", async () => {
    nonAdmin();
    const res = await PUT(putReq({ provider: "claude" }));
    expect(res.status).toBe(403);
    expect(pm.saleDmConfig.upsert).not.toHaveBeenCalled();
  });
  it("監査に変更フィールド名を記録・キー値は残さない", async () => {
    admin();
    await PUT(putReq({ provider: "claude", anthropicApiKey: "sk-secret" }));
    const audit = (writeAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(audit.action).toBe("sale_dm_settings_update");
    expect(audit.detail.fields).toContain("provider");
    expect(audit.detail.fields).toContain("anthropicApiKey");
    expect(JSON.stringify(audit.detail)).not.toContain("sk-secret"); // 値は監査に残さない
  });
});
