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

import { describe, it, expect, beforeEach } from "vitest";
import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { GET, PUT } from "../../app/api/admin/sale-dm-settings/route";

const pm = prismaMock as never as {
  saleDmConfig: { findUnique: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };
};
const putReq = (b: unknown) => new Request("http://x", { method: "PUT", body: JSON.stringify(b) }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1" });
  (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue([{ resource: "user_management", action: "write", granted: true }]);
  pm.saleDmConfig.findUnique.mockResolvedValue(null);
  pm.saleDmConfig.upsert.mockImplementation(async (args: { update: Record<string, unknown> }) => ({
    id: "singleton", provider: null, model: null, trackingBaseUrl: null, lpUrl: null,
    senderName: null, senderContact: null, privacyText: null, googleTagId: null, googleConvLabel: null,
    anthropicApiKeyEnc: null, openaiApiKeyEnc: null, updatedAt: new Date(), ...args.update,
  }));
});

describe("LPの設定: Google のタグ(広告用の公開ページ・設計 2026-10-20)", () => {
  it("GET は googleTagId / googleConvLabel を返す", async () => {
    pm.saleDmConfig.findUnique.mockResolvedValue({
      id: "singleton", provider: null, model: null, trackingBaseUrl: null, lpUrl: null, senderName: null, senderContact: null,
      privacyText: null, googleTagId: "AW-12345ABC", googleConvLabel: "LbL-1234", anthropicApiKeyEnc: null, openaiApiKeyEnc: null, updatedAt: new Date(),
    });
    const json = await (await GET()).json();
    expect(json.data.googleTagId).toBe("AW-12345ABC");
    expect(json.data.googleConvLabel).toBe("LbL-1234");
  });
  it("PUT は許可リストを通した形(大文字の ID)で保存し、空文字はクリア(null)", async () => {
    const res = await PUT(putReq({ googleTagId: " aw-12345abc ", googleConvLabel: " LbL-1234 " }));
    expect(res.status).toBe(200);
    const upd = pm.saleDmConfig.upsert.mock.calls[0][0].update;
    expect(upd.googleTagId).toBe("AW-12345ABC");
    expect(upd.googleConvLabel).toBe("LbL-1234");
    // 応答にも GET と同じ形で返す(画面は応答で欄を上書きするため・@codex #535 R2 P2)
    const saved = await res.json();
    expect(saved.data.googleTagId).toBe("AW-12345ABC");
    expect(saved.data.googleConvLabel).toBe("LbL-1234");
    const res2 = await PUT(putReq({ googleTagId: "", googleConvLabel: "" }));
    expect(res2.status).toBe(200);
    const upd2 = pm.saleDmConfig.upsert.mock.calls[1][0].update;
    expect(upd2.googleTagId).toBeNull();
    expect(upd2.googleConvLabel).toBeNull();
  });
  it("規則外の ID・ラベルは 422 で保存しない", async () => {
    for (const body of [{ googleTagId: "UA-12345-1" }, { googleTagId: "<script>" }, { googleConvLabel: "ab" }, { googleConvLabel: "a b" }]) {
      const res = await PUT(putReq(body));
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    expect(pm.saleDmConfig.upsert).not.toHaveBeenCalled();
  });
  it("送らなかった項目は触らない(部分更新)", async () => {
    await PUT(putReq({ senderName: "X社" }));
    const upd = pm.saleDmConfig.upsert.mock.calls[0][0].update;
    expect("googleTagId" in upd).toBe(false);
    expect("googleConvLabel" in upd).toBe(false);
  });
});
