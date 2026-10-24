/**
 * Google ドライブ連携: 同意画面からの戻り(callback)。
 * - 管理者でなければ 403(JSON)
 * - state が他人・期限切れ・改ざんなら保存せず管理画面へ戻す(error=state)
 * - 正常: コード交換 → about でメール → 暗号化して保存 → 監査 → 管理画面へ(connected=1)
 * - refresh token が返らない → error=no_refresh_token(保存しない)
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {
    get nextUrl() { return new URL(this.url); }
  }
  class MockNextResponse extends Response {
    static json(data: unknown, init?: ResponseInit) { return Response.json(data, init); }
  }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number; code: string;
    constructor(status: number, message: string, code = "ERROR") { super(message); this.status = status; this.code = code; }
  }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(),
    getUserPermissions: vi.fn(),
    handleApiError: vi.fn((e: { status?: number; message?: string; code?: string }) =>
      Response.json({ error: { message: e?.message, code: e?.code } }, { status: e?.status ?? 500 })),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => {
  const db = {
    driveConnection: { upsert: vi.fn(async () => ({})), findUnique: vi.fn(), updateMany: vi.fn() },
    propertyDriveFolder: { count: vi.fn(async () => 0) },
  };
  return { default: db };
});
vi.mock("@/lib/sale-dm-letter/secret-crypto", () => ({
  isSecretCryptoConfigured: () => true,
  encryptSecret: (s: string) => `enc(${s})`,
  decryptSecret: (s: string) => s.replace(/^enc\((.*)\)$/, "$1"),
}));

import prisma from "@/lib/prisma";
import { NextRequest } from "next/server";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { signOauthState } from "@/lib/drive/oauth";
import { GET } from "../callback/route";

const pm = prisma as unknown as { driveConnection: { upsert: Mock } };
const ADMIN = [{ resource: "user_management", action: "write", granted: true }];
const SECRET = "nextauth-secret-for-tests-0123456789";

function req(params: Record<string, string>) {
  const u = new URL("http://t/api/drive/oauth/callback");
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return new NextRequest(u.toString());
}

let fetchMock: Mock;
beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXTAUTH_SECRET = SECRET;
  process.env.NEXTAUTH_URL = "https://pm.example";
  process.env.GOOGLE_DRIVE_CLIENT_ID = "cid";
  process.env.GOOGLE_DRIVE_CLIENT_SECRET = "sec";
  (getApiSession as unknown as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as unknown as Mock).mockResolvedValue(ADMIN);
  fetchMock = vi.fn(async (url: string) => {
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) {
      return Response.json({ access_token: "at", refresh_token: "rt", expires_in: 3599 });
    }
    return Response.json({ user: { emailAddress: "owner@example.com" } });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GOOGLE_DRIVE_CLIENT_ID;
  delete process.env.GOOGLE_DRIVE_CLIENT_SECRET;
});

describe("GET /api/drive/oauth/callback", () => {
  it("★管理者でなければ 403(保存しない)", async () => {
    (getUserPermissions as unknown as Mock).mockResolvedValue([]);
    const res = await GET(req({ code: "c", state: "x" }) as never);
    expect(res.status).toBe(403);
    expect(pm.driveConnection.upsert).not.toHaveBeenCalled();
  });

  it("★他人の state・改ざんは保存せず error=state で戻す(コードの交換もしない)", async () => {
    const other = signOauthState({ secret: SECRET, userId: "u2", nowMs: Date.now() });
    const res = await GET(req({ code: "c", state: other }) as never);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/drive?error=state");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pm.driveConnection.upsert).not.toHaveBeenCalled();
  });

  it("★期限切れ(11分前)の state も通さない", async () => {
    const old = signOauthState({ secret: SECRET, userId: "u1", nowMs: Date.now() - 11 * 60_000 });
    const res = await GET(req({ code: "c", state: old }) as never);
    expect(res.headers.get("location")).toBe("/admin/drive?error=state");
  });

  it("Google が断った(error=access_denied)→ error=denied", async () => {
    const res = await GET(req({ error: "access_denied", state: "x" }) as never);
    expect(res.headers.get("location")).toBe("/admin/drive?error=denied");
  });

  it("正常: 交換 → メール取得 → 暗号化して保存 → 監査(メール・トークンは書かない)→ connected=1", async () => {
    const state = signOauthState({ secret: SECRET, userId: "u1", nowMs: Date.now() });
    const res = await GET(req({ code: "c0de", state }) as never);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/drive?connected=1");
    const call = pm.driveConnection.upsert.mock.calls[0][0];
    expect(call.update.refreshTokenEnc).toBe("enc(rt)");
    expect(call.update.accountEmail).toBe("owner@example.com");
    expect(call.update.startPageToken).toBeNull();
    const audit = (writeAuditLog as unknown as Mock).mock.calls[0][0];
    expect(audit.action).toBe("drive_connect");
    expect(JSON.stringify(audit)).not.toContain("rt");
    expect(JSON.stringify(audit)).not.toContain("owner@example.com");
    // 戻り先 URL は NEXTAUTH_URL + 固定の道
    const form = new URLSearchParams(String(fetchMock.mock.calls[0][1]?.body));
    expect(form.get("redirect_uri")).toBe("https://pm.example/api/drive/oauth/callback");
  });

  it("★refresh token が返らなければ保存せず error=no_refresh_token", async () => {
    fetchMock.mockImplementation(async () => Response.json({ access_token: "at", expires_in: 3599 }));
    const state = signOauthState({ secret: SECRET, userId: "u1", nowMs: Date.now() });
    const res = await GET(req({ code: "c0de", state }) as never);
    expect(res.headers.get("location")).toBe("/admin/drive?error=no_refresh_token");
    expect(pm.driveConnection.upsert).not.toHaveBeenCalled();
  });

  it("クライアント設定(app.env)が無ければ error=not_configured(交換しない)", async () => {
    delete process.env.GOOGLE_DRIVE_CLIENT_ID;
    const state = signOauthState({ secret: SECRET, userId: "u1", nowMs: Date.now() });
    const res = await GET(req({ code: "c0de", state }) as never);
    expect(res.headers.get("location")).toBe("/admin/drive?error=not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
