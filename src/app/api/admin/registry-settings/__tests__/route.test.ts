import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/api-helpers", () => {
  class E extends Error {
    status: number;
    code: string;
    constructor(s: number, m: string, c = "ERROR") {
      super(m);
      this.status = s;
      this.code = c;
    }
  }
  return {
    ApiError: E,
    getApiSession: vi.fn(),
    getUserPermissions: vi.fn(),
    parseJsonBody: vi.fn(async (r: Request) => r.json()),
    handleApiError: vi.fn((e: unknown) => {
      const x = e as { status?: number; code?: string };
      return Response.json(
        { error: { code: x?.code } },
        { status: typeof x?.status === "number" ? x.status : 500 },
      );
    }),
    apiResponse: vi.fn((d: unknown, s = 200) => Response.json(d, { status: s })),
  };
});
vi.mock("@/lib/permissions", () => ({
  hasPermission: (
    perms: Array<{ resource: string; action: string; granted: boolean }>,
    r: string,
    a: string,
  ) => perms.some((p) => p.resource === r && p.action === a && p.granted),
}));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/registry-fetch/secret-crypto", () => ({
  isRegistrySecretCryptoConfigured: vi.fn(() => true),
  encryptRegistrySecret: vi.fn((p: string) => `enc(${p})`),
}));
vi.mock("@/lib/prisma", () => ({
  default: { registryFetchConfig: { findUnique: vi.fn(), upsert: vi.fn() } },
}));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { isRegistrySecretCryptoConfigured } from "@/lib/registry-fetch/secret-crypto";
import { writeAuditLog } from "@/lib/audit";
import { GET, PUT } from "../route";
import type { NextRequest } from "next/server";

const pm = prisma as unknown as {
  registryFetchConfig: { findUnique: Mock; upsert: Mock };
};
const ADMIN = [{ resource: "user_management", action: "write", granted: true }];

function put(body: unknown) {
  return new Request("http://localhost/api/admin/registry-settings", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({ id: "admin-1" });
  (getUserPermissions as Mock).mockResolvedValue(ADMIN);
  (isRegistrySecretCryptoConfigured as Mock).mockReturnValue(true);
  pm.registryFetchConfig.findUnique.mockResolvedValue(null);
  pm.registryFetchConfig.upsert.mockResolvedValue({ updatedAt: new Date() });
});

describe("admin registry-settings route", () => {
  it("非admin(user_management:write 無)は GET/PUT 403", async () => {
    (getUserPermissions as Mock).mockResolvedValue([]);
    expect((await GET()).status).toBe(403);
    expect((await PUT(put({ loginId: "x" }))).status).toBe(403);
  });

  it("GET は設定済booleans・暗号文を返さない", async () => {
    pm.registryFetchConfig.findUnique.mockResolvedValue({
      loginIdEnc: "enc-abc",
      passwordEnc: null,
      baseUrl: "https://x",
      updatedAt: new Date(),
    });
    const res = await GET();
    const body = await res.json();
    expect(body).toMatchObject({
      hasLoginId: true,
      hasPassword: false,
      baseUrl: "https://x",
      encryptionConfigured: true,
    });
    expect(JSON.stringify(body)).not.toContain("enc-abc");
  });

  it("PUT は loginId/password を暗号化して upsert・baseUrl は平文", async () => {
    await PUT(put({ loginId: "user9", password: "pass9", baseUrl: "https://touki" }));
    const args = pm.registryFetchConfig.upsert.mock.calls[0]![0];
    expect(args.update.loginIdEnc).toBe("enc(user9)");
    expect(args.update.passwordEnc).toBe("enc(pass9)");
    expect(args.update.baseUrl).toBe("https://touki");
  });

  it("鍵未設定で秘匿値保存は 503(平文保存しない)", async () => {
    (isRegistrySecretCryptoConfigured as Mock).mockReturnValue(false);
    const res = await PUT(put({ loginId: "x" }));
    expect(res.status).toBe(503);
    expect(pm.registryFetchConfig.upsert).not.toHaveBeenCalled();
  });

  it("空文字は clear(null 保存)", async () => {
    await PUT(put({ loginId: "" }));
    const args = pm.registryFetchConfig.upsert.mock.calls[0]![0];
    expect(args.update.loginIdEnc).toBeNull();
  });

  it("秘匿値は trim せずそのまま暗号化(前後空白を保持)", async () => {
    await PUT(put({ password: "  spaced pw  " }));
    const args = pm.registryFetchConfig.upsert.mock.calls[0]![0];
    expect(args.update.passwordEnc).toBe("enc(  spaced pw  )");
  });

  it("監査は変更フィールド名のみ(値を出さない)", async () => {
    await PUT(put({ loginId: "user9" }));
    const audit = (writeAuditLog as unknown as Mock).mock.calls[0]![0];
    expect(audit.detail.changed).toContain("loginId");
    expect(JSON.stringify(audit.detail)).not.toContain("user9");
  });

  it("監査は targetId(UUID列)に singleton を入れない(無記録化を防ぐ)", async () => {
    await PUT(put({ loginId: "user9" }));
    const audit = (writeAuditLog as unknown as Mock).mock.calls[0]![0];
    expect(audit.targetId).toBeUndefined();
    expect(audit.targetTable).toBe("registry_fetch_config");
    expect(audit.detail.target).toBe("singleton");
  });
});
