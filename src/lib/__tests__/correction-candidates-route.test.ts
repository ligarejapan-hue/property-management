/**
 * GET /api/admin/owners/correction-candidates の duplicate グループ機能テスト。
 *
 * Phase 2-B-α: 重複候補に opaque な duplicateGroupId と duplicateGroupSize を付与。
 *   - server-side の正規化キー (buildOwnerDuplicateCandidateKey) でグループ化
 *   - 表記揺れ（全角空白等）のペアも同じグループ
 *   - duplicateGroupId は raw name/address/normalized key を含まない opaque 値
 *   - groupSize >= 2 のグループのみ ID 付与
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {
    constructor(input: string | URL | Request, init?: RequestInit) {
      super(input, init);
    }
  }
  return { NextRequest: MockNextRequest };
});

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
    getApiSession: vi.fn().mockResolvedValue({
      id: "user-1",
      email: "admin@test.com",
      name: "Admin",
      role: "admin",
    }),
    getUserPermissions: vi.fn().mockResolvedValue([
      { resource: "user_management", action: "read", granted: true },
      { resource: "owner", action: "read", granted: true },
      { resource: "owner_name", action: "full", granted: true },
      { resource: "owner_address", action: "full", granted: true },
      { resource: "owner_zip", action: "full", granted: true },
      { resource: "owner_phone", action: "full", granted: true },
      { resource: "owner_email", action: "full", granted: true },
      { resource: "owner_note", action: "full", granted: true },
      { resource: "owner_name_kana", action: "full", granted: true },
    ]),
    getOwnerDisplayConfig: vi.fn().mockResolvedValue({
      name: "full",
      nameKana: "full",
      phone: "full",
      zip: "full",
      address: "full",
      note: "full",
      email: "full",
    }),
    handleApiError: vi.fn((error: unknown) => {
      if (error instanceof MockApiError) {
        return Response.json(
          { error: { message: error.message, code: error.code } },
          { status: error.status },
        );
      }
      return Response.json(
        { error: { message: "Server error", code: "INTERNAL_ERROR" } },
        { status: 500 },
      );
    }),
    apiResponse: vi.fn((data: unknown, status = 200) =>
      Response.json(data, { status }),
    ),
  };
});

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  default: {
    owner: { findMany: vi.fn() },
    changeLog: { findMany: vi.fn() },
    importJobRow: { findMany: vi.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { GET } from "../../app/api/admin/owners/correction-candidates/route";

const pm = prisma as unknown as {
  owner: { findMany: Mock };
  changeLog: { findMany: Mock };
  importJobRow: { findMany: Mock };
};

function makeOwner(overrides: {
  id: string;
  name: string;
  address?: string | null;
  zip?: string | null;
  phone?: string | null;
  propertyOwnerCount?: number;
  version?: number;
  note?: string | null;
  externalLinkKey?: string | null;
  corporateNumber?: string | null;
}) {
  return {
    id: overrides.id,
    name: overrides.name,
    address: overrides.address ?? null,
    zip: overrides.zip ?? null,
    phone: overrides.phone ?? null,
    note: overrides.note ?? null,
    externalLinkKey: overrides.externalLinkKey ?? null,
    corporateNumber: overrides.corporateNumber ?? null,
    version: overrides.version ?? 1,
    _count: { propertyOwners: overrides.propertyOwnerCount ?? 0 },
  };
}

function makeRequest(type: "all" | "duplicate" | "orphan" | "address_null" = "duplicate") {
  return new Request(
    `http://localhost/api/admin/owners/correction-candidates?type=${type}`,
    { method: "GET" },
  ) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  pm.changeLog.findMany.mockResolvedValue([]);
  pm.importJobRow.findMany.mockResolvedValue([]);
});

describe("GET correction-candidates: duplicateGroupId / duplicateGroupSize", () => {
  it("表記揺れ（全角空白）のあるペアでも同じ duplicateGroupId が返る", async () => {
    pm.owner.findMany.mockResolvedValue([
      makeOwner({ id: "11111111-1111-4111-8111-111111111111", name: "田中太郎", address: "東京都港区1-1" }),
      // 全角空白を含む別表記。normalizeName で同値扱い。
      makeOwner({ id: "22222222-2222-4222-8222-222222222222", name: "田中 太郎", address: "東京都港区1-1" }),
      // 無関係な単独 owner
      makeOwner({ id: "33333333-3333-4333-8333-333333333333", name: "鈴木次郎", address: "大阪府大阪市2-2" }),
    ]);

    const res = await GET(makeRequest("duplicate"));
    const json = await res.json();

    expect(json.candidates).toHaveLength(2);
    const ids = json.candidates.map((c: { duplicateGroupId: string }) => c.duplicateGroupId);
    expect(ids[0]).toBeDefined();
    expect(ids[1]).toBeDefined();
    expect(ids[0]).toBe(ids[1]); // 同一グループ
    expect(json.candidates[0].duplicateGroupSize).toBe(2);
    expect(json.candidates[1].duplicateGroupSize).toBe(2);
  });

  it("address なし + zip + phone fallback で一致するペアも同じグループに入る", async () => {
    pm.owner.findMany.mockResolvedValue([
      makeOwner({
        id: "44444444-4444-4444-8444-444444444444",
        name: "山田花子",
        address: null,
        zip: "100-0001",
        phone: "090-1234-5678",
      }),
      makeOwner({
        id: "55555555-5555-4555-8555-555555555555",
        name: "山田 花子",
        address: null,
        zip: "100-0001",
        phone: "090-1234-5678",
      }),
    ]);

    const res = await GET(makeRequest("duplicate"));
    const json = await res.json();
    expect(json.candidates).toHaveLength(2);
    expect(json.candidates[0].duplicateGroupId).toBe(
      json.candidates[1].duplicateGroupId,
    );
    expect(json.candidates[0].duplicateGroupSize).toBe(2);
  });

  it("duplicateGroupId は raw name/address/normalized key を含まない opaque 値", async () => {
    const NAME = "佐藤一郎";
    const ADDRESS = "東京都新宿区3-3";
    pm.owner.findMany.mockResolvedValue([
      makeOwner({ id: "66666666-6666-4666-8666-666666666666", name: NAME, address: ADDRESS }),
      makeOwner({ id: "77777777-7777-4777-8777-777777777777", name: NAME, address: ADDRESS }),
    ]);

    const res = await GET(makeRequest("duplicate"));
    const json = await res.json();
    for (const c of json.candidates as { duplicateGroupId: string }[]) {
      const id = c.duplicateGroupId;
      expect(id).toBeDefined();
      expect(id).not.toContain(NAME);
      expect(id).not.toContain(ADDRESS);
      // 正規化済みも含まない（normalizeName/normalizeAddress 結果も raw に近い）
      expect(id).not.toMatch(/佐藤/);
      expect(id).not.toMatch(/新宿/);
      // dup- prefix の opaque ID であること
      expect(id).toMatch(/^dup-\d+$/);
    }
  });

  it("単独の duplicate でない owner には duplicateGroupId=null / duplicateGroupSize=null", async () => {
    pm.owner.findMany.mockResolvedValue([
      makeOwner({ id: "88888888-8888-4888-8888-888888888888", name: "孤独太郎", address: "東京都中野区4-4" }),
    ]);

    const res = await GET(makeRequest("all"));
    const json = await res.json();
    expect(json.candidates.length).toBeGreaterThanOrEqual(0);
    for (const c of json.candidates) {
      // 単独owner は duplicate にならない
      expect(c.duplicateGroupId).toBeNull();
      expect(c.duplicateGroupSize).toBeNull();
    }
  });

  it("複数グループに別々の dup-N が割り当てられる", async () => {
    pm.owner.findMany.mockResolvedValue([
      makeOwner({ id: "aaaaaaaa-1111-4111-8111-111111111111", name: "A", address: "X" }),
      makeOwner({ id: "aaaaaaaa-2222-4222-8222-222222222222", name: "A", address: "X" }),
      makeOwner({ id: "bbbbbbbb-1111-4111-8111-111111111111", name: "B", address: "Y" }),
      makeOwner({ id: "bbbbbbbb-2222-4222-8222-222222222222", name: "B", address: "Y" }),
    ]);

    const res = await GET(makeRequest("duplicate"));
    const json = await res.json();
    expect(json.candidates).toHaveLength(4);
    const groupIds = new Set(
      (json.candidates as { duplicateGroupId: string }[]).map(
        (c) => c.duplicateGroupId,
      ),
    );
    expect(groupIds.size).toBe(2);
  });

  it("AuditLog detail に raw name/address や duplicateGroupId 内容は含めない", async () => {
    pm.owner.findMany.mockResolvedValue([
      makeOwner({ id: "99999999-9999-4999-8999-999999999999", name: "PII太郎", address: "PII住所1-1" }),
      makeOwner({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "PII太郎", address: "PII住所1-1" }),
    ]);

    const { writeAuditLog } = await import("@/lib/audit");
    await GET(makeRequest("duplicate"));
    const auditCall = vi.mocked(writeAuditLog).mock.calls[0]?.[0];
    expect(auditCall).toBeDefined();
    const serialized = JSON.stringify(auditCall!.detail);
    expect(serialized).not.toContain("PII太郎");
    expect(serialized).not.toContain("PII住所");
  });
});

// ---- Phase E 同時修正回帰: corporate_number マスキング ----
describe("GET correction-candidates: Phase E corporate_number マスキング", () => {
  const CN = "1234567890123";

  it("owner_corporate_number=full → 生値返却", async () => {
    const { getOwnerDisplayConfig } = await import("@/lib/api-helpers");
    vi.mocked(getOwnerDisplayConfig).mockResolvedValueOnce({
      name: "full",
      nameKana: "full",
      phone: "full",
      zip: "full",
      address: "full",
      note: "full",
      email: "full",
      corporateNumber: "full",
    } as unknown as Awaited<ReturnType<typeof getOwnerDisplayConfig>>);
    pm.owner.findMany.mockResolvedValue([
      makeOwner({
        id: "11111111-1111-4111-8111-111111111111",
        name: "法人太郎",
        propertyOwnerCount: 0,
        corporateNumber: CN,
      }),
    ]);
    const res = await GET(makeRequest("orphan"));
    const json = await res.json();
    expect(json.candidates[0].corporateNumberMasked).toBe(CN);
  });

  it("owner_corporate_number=masked → 先頭4桁マスク（生値が出ない）", async () => {
    const { getOwnerDisplayConfig } = await import("@/lib/api-helpers");
    vi.mocked(getOwnerDisplayConfig).mockResolvedValueOnce({
      name: "full",
      nameKana: "full",
      phone: "full",
      zip: "full",
      address: "full",
      note: "full",
      email: "full",
      corporateNumber: "masked",
    } as unknown as Awaited<ReturnType<typeof getOwnerDisplayConfig>>);
    pm.owner.findMany.mockResolvedValue([
      makeOwner({
        id: "11111111-1111-4111-8111-111111111111",
        name: "法人太郎",
        propertyOwnerCount: 0,
        corporateNumber: CN,
      }),
    ]);
    const res = await GET(makeRequest("orphan"));
    const json = await res.json();
    expect(json.candidates[0].corporateNumberMasked).not.toBe(CN);
    expect(json.candidates[0].corporateNumberMasked).toMatch(/^\d{4}\*+$/);
  });

  it("owner_corporate_number=edit → マスク（事前確定方針: full のみ生値）", async () => {
    const { getOwnerDisplayConfig } = await import("@/lib/api-helpers");
    vi.mocked(getOwnerDisplayConfig).mockResolvedValueOnce({
      name: "full",
      nameKana: "full",
      phone: "full",
      zip: "full",
      address: "full",
      note: "full",
      email: "full",
      corporateNumber: "edit",
    } as unknown as Awaited<ReturnType<typeof getOwnerDisplayConfig>>);
    pm.owner.findMany.mockResolvedValue([
      makeOwner({
        id: "11111111-1111-4111-8111-111111111111",
        name: "法人太郎",
        propertyOwnerCount: 0,
        corporateNumber: CN,
      }),
    ]);
    const res = await GET(makeRequest("orphan"));
    const json = await res.json();
    expect(json.candidates[0].corporateNumberMasked).not.toBe(CN);
    expect(json.candidates[0].corporateNumberMasked).toMatch(/^\d{4}\*+$/);
  });

  it("owner_corporate_number=read → マスク（事前確定方針: full のみ生値）", async () => {
    const { getOwnerDisplayConfig } = await import("@/lib/api-helpers");
    vi.mocked(getOwnerDisplayConfig).mockResolvedValueOnce({
      name: "full",
      nameKana: "full",
      phone: "full",
      zip: "full",
      address: "full",
      note: "full",
      email: "full",
      corporateNumber: "read",
    } as unknown as Awaited<ReturnType<typeof getOwnerDisplayConfig>>);
    pm.owner.findMany.mockResolvedValue([
      makeOwner({
        id: "11111111-1111-4111-8111-111111111111",
        name: "法人太郎",
        propertyOwnerCount: 0,
        corporateNumber: CN,
      }),
    ]);
    const res = await GET(makeRequest("orphan"));
    const json = await res.json();
    expect(json.candidates[0].corporateNumberMasked).not.toBe(CN);
    expect(json.candidates[0].corporateNumberMasked).toMatch(/^\d{4}\*+$/);
  });

  it("owner_corporate_number=partial → マスク", async () => {
    const { getOwnerDisplayConfig } = await import("@/lib/api-helpers");
    vi.mocked(getOwnerDisplayConfig).mockResolvedValueOnce({
      name: "full",
      nameKana: "full",
      phone: "full",
      zip: "full",
      address: "full",
      note: "full",
      email: "full",
      corporateNumber: "partial",
    } as unknown as Awaited<ReturnType<typeof getOwnerDisplayConfig>>);
    pm.owner.findMany.mockResolvedValue([
      makeOwner({
        id: "11111111-1111-4111-8111-111111111111",
        name: "法人太郎",
        propertyOwnerCount: 0,
        corporateNumber: CN,
      }),
    ]);
    const res = await GET(makeRequest("orphan"));
    const json = await res.json();
    expect(json.candidates[0].corporateNumberMasked).not.toBe(CN);
    expect(json.candidates[0].corporateNumberMasked).toMatch(/^\d{4}\*+$/);
  });

  it("owner_corporate_number=hidden → null", async () => {
    const { getOwnerDisplayConfig } = await import("@/lib/api-helpers");
    vi.mocked(getOwnerDisplayConfig).mockResolvedValueOnce({
      name: "full",
      nameKana: "full",
      phone: "full",
      zip: "full",
      address: "full",
      note: "full",
      email: "full",
      corporateNumber: "hidden",
    } as unknown as Awaited<ReturnType<typeof getOwnerDisplayConfig>>);
    pm.owner.findMany.mockResolvedValue([
      makeOwner({
        id: "11111111-1111-4111-8111-111111111111",
        name: "法人太郎",
        propertyOwnerCount: 0,
        corporateNumber: CN,
      }),
    ]);
    const res = await GET(makeRequest("orphan"));
    const json = await res.json();
    expect(json.candidates[0].corporateNumberMasked).toBeNull();
  });

  it("Owner.corporateNumber=null は corporateNumberMasked=null", async () => {
    pm.owner.findMany.mockResolvedValue([
      makeOwner({
        id: "11111111-1111-4111-8111-111111111111",
        name: "法人太郎",
        propertyOwnerCount: 0,
        corporateNumber: null,
      }),
    ]);
    const res = await GET(makeRequest("orphan"));
    const json = await res.json();
    expect(json.candidates[0].corporateNumberMasked).toBeNull();
  });

  it("AuditLog detail に法人番号生値が含まれない", async () => {
    const { getOwnerDisplayConfig } = await import("@/lib/api-helpers");
    vi.mocked(getOwnerDisplayConfig).mockResolvedValueOnce({
      name: "full",
      nameKana: "full",
      phone: "full",
      zip: "full",
      address: "full",
      note: "full",
      email: "full",
      corporateNumber: "full",
    } as unknown as Awaited<ReturnType<typeof getOwnerDisplayConfig>>);
    pm.owner.findMany.mockResolvedValue([
      makeOwner({
        id: "11111111-1111-4111-8111-111111111111",
        name: "法人太郎",
        propertyOwnerCount: 0,
        corporateNumber: CN,
      }),
    ]);
    const { writeAuditLog } = await import("@/lib/audit");
    await GET(makeRequest("orphan"));
    const detailJson = JSON.stringify(
      vi.mocked(writeAuditLog).mock.calls[0]?.[0]?.detail ?? {},
    );
    expect(detailJson).not.toContain(CN);
  });
});
