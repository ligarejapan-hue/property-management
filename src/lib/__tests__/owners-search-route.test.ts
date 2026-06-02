// PII-S1a: GET /api/owners/search の PII guard ルートテスト。
//
// 検証方針（registry-auto-fetch-api.test.ts / quality-check route に倣う）:
//  - api-helpers（getApiSession / getUserPermissions / getOwnerDisplayConfig）と prisma / audit を mock。
//  - permissions（hasPermission / maskValue）は実物を使い、実際のマスク挙動で検証する。
//  - route は request.nextUrl.searchParams のみ使うため、{ nextUrl } を持つ最小オブジェクトを渡す。
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("next/server", () => ({ NextRequest: class MockNextRequest {} }));

vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(),
    getUserPermissions: vi.fn(),
    getOwnerDisplayConfig: vi.fn(),
    apiResponse: vi.fn((data: unknown, status = 200) =>
      Response.json(data as Record<string, unknown>, { status }),
    ),
    handleApiError: vi.fn((error: unknown) => {
      const e = error as { status?: number; message?: string; code?: string };
      if (typeof e?.status === "number") {
        return Response.json(
          { error: { message: e.message, code: e.code } },
          { status: e.status },
        );
      }
      return Response.json(
        { error: { message: "Server error", code: "INTERNAL_ERROR" } },
        { status: 500 },
      );
    }),
  };
});

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ default: { owner: { findMany: vi.fn() } } }));

import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { GET } from "@/app/api/owners/search/route";

const pm = prisma as unknown as { owner: { findMany: Mock } };

const FULL_CONFIG = {
  name: "full",
  nameKana: "full",
  phone: "full",
  zip: "full",
  address: "full",
  note: "full",
  email: "full",
  corporateNumber: "full",
};
// field_staff 相当: 氏名/カナは full、phone masked、address partial、他 masked/hidden。
const FIELD_STAFF_CONFIG = {
  name: "full",
  nameKana: "full",
  phone: "masked",
  zip: "masked",
  address: "partial",
  note: "hidden",
  email: "masked",
  corporateNumber: "masked",
};
const HIDDEN_CONFIG = {
  name: "hidden",
  nameKana: "hidden",
  phone: "hidden",
  zip: "hidden",
  address: "hidden",
  note: "hidden",
  email: "hidden",
  corporateNumber: "hidden",
};

const PERMS_OWNER_READ = [{ resource: "owner", action: "read", granted: true }];
const PERMS_NONE: Array<{ resource: string; action: string; granted: boolean }> = [];

const OWNER_ROW = {
  id: "o1",
  name: "山田太郎",
  nameKana: "ヤマダタロウ",
  phone: "090-1234-5678",
  address: "東京都港区1-2-3",
  externalLinkKey: "EXT-1",
};

function callRoute(q: string) {
  const url = `http://test/api/owners/search?q=${encodeURIComponent(q)}`;
  const req = { nextUrl: new URL(url) } as unknown as Parameters<typeof GET>[0];
  return GET(req);
}

function orKeysOf(): string[] {
  const where = pm.owner.findMany.mock.calls[0][0].where as {
    OR: Array<Record<string, unknown>>;
  };
  return where.OR.map((c) => Object.keys(c)[0]).sort();
}

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({
    id: "user-1",
    role: "admin",
    email: "u@test",
    name: "U",
  });
  (getUserPermissions as Mock).mockResolvedValue(PERMS_OWNER_READ);
  (getOwnerDisplayConfig as Mock).mockResolvedValue(FULL_CONFIG);
  pm.owner.findMany.mockResolvedValue([]);
});

describe("PII-S1a: GET /api/owners/search PII guard", () => {
  it("owner:read 無しは 403・DB 未検索", async () => {
    (getUserPermissions as Mock).mockResolvedValue(PERMS_NONE);
    const res = await callRoute("山田");
    expect(res.status).toBe(403);
    expect(pm.owner.findMany).not.toHaveBeenCalled();
  });

  it("q 空は DB 未検索で空配列", async () => {
    const res = await callRoute("   ");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(pm.owner.findMany).not.toHaveBeenCalled();
  });

  it("full 権限: 全フィールドが where.OR に入り、応答は非マスク（従来挙動）", async () => {
    pm.owner.findMany.mockResolvedValue([{ ...OWNER_ROW }]);
    const res = await callRoute("山田");
    expect(res.status).toBe(200);
    expect(orKeysOf()).toEqual([
      "address",
      "externalLinkKey",
      "name",
      "nameKana",
      "phone",
    ]);
    const body = await res.json();
    expect(body.data[0]).toEqual(OWNER_ROW);
  });

  it("masked/partial/hidden フィールドは where.OR から除外され、応答値はマスク（オラクル封じ）", async () => {
    (getOwnerDisplayConfig as Mock).mockResolvedValue(FIELD_STAFF_CONFIG);
    pm.owner.findMany.mockResolvedValue([{ ...OWNER_ROW }]);
    const res = await callRoute("山田");
    // name/nameKana(full)のみ検索可。phone(masked)/address(partial)/externalLinkKey(full可視でない)は除外。
    expect(orKeysOf()).toEqual(["name", "nameKana"]);
    const body = await res.json();
    const row = body.data[0];
    expect(row.name).toBe("山田太郎"); // full
    expect(row.phone).toBe("***5678"); // masked: *** + 末尾4
    expect(row.address).toBe("東京都***"); // partial: 先頭3 + ***
    expect(row.externalLinkKey).toBeNull(); // full可視でない → null
  });

  it("検索可能フィールドが0（全 hidden）は DB 未検索で空配列", async () => {
    (getOwnerDisplayConfig as Mock).mockResolvedValue(HIDDEN_CONFIG);
    const res = await callRoute("山田");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(pm.owner.findMany).not.toHaveBeenCalled();
  });

  it("externalLinkKey は全項目 unmasked でないと where.OR にも応答にも出ない", async () => {
    (getOwnerDisplayConfig as Mock).mockResolvedValue(FIELD_STAFF_CONFIG);
    pm.owner.findMany.mockResolvedValue([{ ...OWNER_ROW }]);
    const res = await callRoute("EXT-1");
    expect(orKeysOf()).not.toContain("externalLinkKey");
    const body = await res.json();
    expect(body.data[0].externalLinkKey).toBeNull();
  });

  it("AuditLog owner_search に q / PII を残さず、件数とフィールドboolean のみ", async () => {
    pm.owner.findMany.mockResolvedValue([{ ...OWNER_ROW }]);
    await callRoute("090-1234-5678");
    const call = (writeAuditLog as Mock).mock.calls.find(
      (c) => c[0]?.action === "owner_search",
    );
    expect(call).toBeTruthy();
    const detail = call![0].detail as Record<string, unknown>;
    expect(detail.resultCount).toBe(1);
    expect(typeof detail.searchableFields).toBe("object");
    const json = JSON.stringify(call![0]);
    expect(json).not.toContain("090-1234-5678"); // 検索語 q
    expect(json).not.toContain("山田太郎"); // 氏名
    expect(json).not.toContain("東京都港区1-2-3"); // 住所
    expect(json).not.toContain("EXT-1"); // externalLinkKey
  });

  it("応答キー形状（id,name,nameKana,phone,address,externalLinkKey）を維持する", async () => {
    pm.owner.findMany.mockResolvedValue([{ ...OWNER_ROW }]);
    const res = await callRoute("山田");
    const body = await res.json();
    expect(Object.keys(body.data[0]).sort()).toEqual([
      "address",
      "externalLinkKey",
      "id",
      "name",
      "nameKana",
      "phone",
    ]);
  });
});
