/**
 * Google ドライブ連携: 物件とフォルダの紐づけ(POST/DELETE)と状態(GET/DELETE)。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

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
    parseJsonBody: vi.fn(async (r: Request) => r.json()),
    handleApiError: vi.fn((e: { status?: number; message?: string; code?: string; issues?: unknown }) =>
      Response.json({ error: { message: e?.message, code: e?.code } }, { status: e?.status ?? (e?.issues ? 422 : 500) })),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => {
  const db = {
    property: { findUnique: vi.fn() },
    propertyDriveFolder: {
      findFirst: vi.fn(), findMany: vi.fn(async () => []), findUnique: vi.fn(), create: vi.fn(), delete: vi.fn(), count: vi.fn(async () => 0),
    },
    driveConnection: { findUnique: vi.fn(), updateMany: vi.fn(), upsert: vi.fn() },
  };
  return { default: db };
});
vi.mock("@/lib/sale-dm-letter/secret-crypto", () => ({
  isSecretCryptoConfigured: () => true,
  encryptSecret: (s: string) => `enc(${s})`,
  decryptSecret: (s: string) => s.replace(/^enc\((.*)\)$/, "$1"),
}));
const getFolder = vi.fn();
const folderPath = vi.fn(async () => "ハマイハイライズ 305 › 売却");
vi.mock("@/lib/drive/connection", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/drive/connection")>();
  return { ...orig, getDriveClient: vi.fn(async () => ({ getFolder, folderPath })) };
});

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { POST as linksPost } from "../links/route";
import { DELETE as linkDelete } from "../links/[id]/route";
import { GET as statusGet, DELETE as disconnect } from "../route";

const pm = prisma as unknown as {
  property: { findUnique: Mock };
  propertyDriveFolder: { findFirst: Mock; findUnique: Mock; create: Mock; delete: Mock };
  driveConnection: { findUnique: Mock; updateMany: Mock };
};
const ADMIN = [{ resource: "user_management", action: "write", granted: true }];
const PROP = "11111111-1111-4111-8111-111111111111";
const LINK = "22222222-2222-4222-8222-222222222222";

function post(body: unknown) {
  return new Request("http://t/api/admin/drive/links", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as unknown as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as unknown as Mock).mockResolvedValue(ADMIN);
  pm.property.findUnique.mockResolvedValue({ id: PROP });
  pm.propertyDriveFolder.findFirst.mockResolvedValue(null);
  pm.propertyDriveFolder.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: LINK, ...data, property: {} }));
  getFolder.mockResolvedValue({ id: "f1", name: "売却", parents: ["p"], trashed: false, webViewLink: "https://drive.google.com/f1" });
  process.env.GOOGLE_DRIVE_CLIENT_ID = "cid";
  process.env.GOOGLE_DRIVE_CLIENT_SECRET = "sec";
  process.env.NEXTAUTH_URL = "https://pm.example";
  process.env.NEXTAUTH_SECRET = "nextauth-secret-for-tests-0123456789";
});

describe("POST /api/admin/drive/links", () => {
  it("★管理者でなければ 403", async () => {
    (getUserPermissions as unknown as Mock).mockResolvedValue([{ resource: "property", action: "write", granted: true }]);
    const res = await linksPost(post({ propertyId: PROP, folderId: "f1" }) as never);
    expect(res.status).toBe(403);
    expect(pm.propertyDriveFolder.create).not.toHaveBeenCalled();
  });
  it("正常: ドライブで実在のフォルダを確かめ、道と名前を控えて 201。監査にはフォルダ名を書かない", async () => {
    const res = await linksPost(post({ propertyId: PROP, folderId: "f1" }) as never);
    expect(res.status).toBe(201);
    const data = pm.propertyDriveFolder.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ propertyId: PROP, folderId: "f1", folderName: "売却", folderPath: "ハマイハイライズ 305 › 売却", linkedById: "u1" });
    const audit = (writeAuditLog as unknown as Mock).mock.calls[0][0];
    expect(audit).toMatchObject({ action: "drive_folder_link", targetTable: "property_drive_folders", targetId: LINK, detail: { propertyId: PROP } });
    expect(JSON.stringify(audit)).not.toContain("ハマイ");
  });
  it("★フォルダでない・ゴミ箱・無い → 404(作らない)", async () => {
    getFolder.mockResolvedValue(null);
    expect((await linksPost(post({ propertyId: PROP, folderId: "zz" }) as never)).status).toBe(404);
    getFolder.mockResolvedValue({ id: "f1", name: "x", parents: [], trashed: true, webViewLink: null });
    expect((await linksPost(post({ propertyId: PROP, folderId: "f1" }) as never)).status).toBe(404);
    expect(pm.propertyDriveFolder.create).not.toHaveBeenCalled();
  });
  it("★すでに紐づいている物件・フォルダは 409", async () => {
    pm.propertyDriveFolder.findFirst.mockResolvedValue({ propertyId: PROP, folderId: "other" });
    const res = await linksPost(post({ propertyId: PROP, folderId: "f1" }) as never);
    expect(res.status).toBe(409);
    expect(pm.propertyDriveFolder.create).not.toHaveBeenCalled();
  });
  it("入力の形が違えば 422(フォルダ id に使えない文字・物件 id が uuid でない)", async () => {
    expect((await linksPost(post({ propertyId: "x", folderId: "f1" }) as never)).status).toBe(422);
    expect((await linksPost(post({ propertyId: PROP, folderId: "a b'" }) as never)).status).toBe(422);
  });
  it("物件が無ければ 404", async () => {
    pm.property.findUnique.mockResolvedValue(null);
    expect((await linksPost(post({ propertyId: PROP, folderId: "f1" }) as never)).status).toBe(404);
  });
});

describe("DELETE /api/admin/drive/links/[id]", () => {
  it("外すと監査(物件 ID だけ)", async () => {
    pm.propertyDriveFolder.findUnique.mockResolvedValue({ id: LINK, propertyId: PROP });
    const res = await linkDelete(new Request("http://t/"), { params: Promise.resolve({ id: LINK }) });
    expect(res.status).toBe(200);
    expect(pm.propertyDriveFolder.delete).toHaveBeenCalledWith({ where: { id: LINK } });
    expect((writeAuditLog as unknown as Mock).mock.calls[0][0]).toMatchObject({ action: "drive_folder_unlink", targetId: LINK, detail: { propertyId: PROP } });
  });
  it("無ければ 404・管理者でなければ 403", async () => {
    pm.propertyDriveFolder.findUnique.mockResolvedValue(null);
    expect((await linkDelete(new Request("http://t/"), { params: Promise.resolve({ id: LINK }) })).status).toBe(404);
    (getUserPermissions as unknown as Mock).mockResolvedValue([]);
    expect((await linkDelete(new Request("http://t/"), { params: Promise.resolve({ id: LINK }) })).status).toBe(403);
  });
});

describe("GET/DELETE /api/admin/drive(状態・接続を切る)", () => {
  it("状態: トークンは返さない・設定の有無と戻り先 URL を返す", async () => {
    pm.driveConnection.findUnique.mockResolvedValue({
      id: "singleton", accountEmail: "owner@example.com", refreshTokenEnc: "enc(rt)", startPageToken: null,
      lastSyncAt: null, lastError: null, consecutiveFailures: 0, connectedAt: new Date("2026-10-24T01:00:00Z"),
    });
    const res = await statusGet();
    const json = await res.json();
    expect(json.data).toMatchObject({
      connected: true, accountEmail: "owner@example.com", clientConfigured: true, cryptoConfigured: true,
      redirectUri: "https://pm.example/api/drive/oauth/callback", linkedFolderCount: 0,
    });
    expect(JSON.stringify(json)).not.toContain("rt");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  it("未接続ならメールも出さない", async () => {
    pm.driveConnection.findUnique.mockResolvedValue({ id: "singleton", accountEmail: "old@example.com", refreshTokenEnc: null, consecutiveFailures: 0 });
    const json = await (await statusGet()).json();
    expect(json.data.connected).toBe(false);
    expect(json.data.accountEmail).toBeNull();
  });
  it("接続を切る: トークンを消して監査", async () => {
    pm.driveConnection.findUnique.mockResolvedValue(null);
    const res = await disconnect();
    expect(res.status).toBe(200);
    expect(pm.driveConnection.updateMany.mock.calls[0][0].data.refreshTokenEnc).toBeNull();
    expect((writeAuditLog as unknown as Mock).mock.calls[0][0].action).toBe("drive_disconnect");
  });
});
