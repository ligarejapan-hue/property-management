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

// ---- Phase 2-A: corporate_number / external_link_key duplicate 検出 ----
describe("GET correction-candidates: Phase 2-A duplicate by corporate_number", () => {
  const CN_VALID_A = "1234567890123";
  const CN_VALID_B = "9876543210987";

  it("同じ corporateNumber を持つ owner ペアは duplicate 化される（dup-cn-N / matchedBy=corporate_number）", async () => {
    pm.owner.findMany.mockResolvedValue([
      makeOwner({
        id: "11111111-1111-4111-8111-111111111111",
        name: "法人A支店1",
        address: "東京都港区A-1",
        corporateNumber: CN_VALID_A,
      }),
      makeOwner({
        id: "22222222-2222-4222-8222-222222222222",
        name: "法人A支店2",
        address: "大阪府大阪市A-2",
        corporateNumber: CN_VALID_A,
      }),
    ]);

    const res = await GET(makeRequest("duplicate"));
    const json = await res.json();
    expect(json.candidates).toHaveLength(2);
    expect(json.candidates[0].duplicateGroupId).toBe(
      json.candidates[1].duplicateGroupId,
    );
    expect(json.candidates[0].duplicateGroupId).toMatch(/^dup-cn-\d+$/);
    expect(json.candidates[0].duplicateMatchedBy).toBe("corporate_number");
    expect(json.candidates[1].duplicateMatchedBy).toBe("corporate_number");
    expect(json.candidates[0].duplicateGroupSize).toBe(2);
  });

  it("name_address と corporate_number 両方一致 → name_address が優先される（既存挙動）", async () => {
    pm.owner.findMany.mockResolvedValue([
      makeOwner({
        id: "11111111-1111-4111-8111-111111111111",
        name: "同名同住所",
        address: "東京都港区1-1",
        corporateNumber: CN_VALID_A,
      }),
      makeOwner({
        id: "22222222-2222-4222-8222-222222222222",
        name: "同名同住所",
        address: "東京都港区1-1",
        corporateNumber: CN_VALID_A,
      }),
    ]);

    const res = await GET(makeRequest("duplicate"));
    const json = await res.json();
    expect(json.candidates[0].duplicateMatchedBy).toBe("name_address");
    expect(json.candidates[0].duplicateGroupId).toMatch(/^dup-\d+$/);
    expect(json.candidates[0].duplicateGroupId).not.toMatch(/^dup-cn-/);
  });

  it("12桁 / null / 空文字 / ハイフンで 13桁未満 → duplicate にならない", async () => {
    pm.owner.findMany.mockResolvedValue([
      makeOwner({
        id: "11111111-1111-4111-8111-111111111111",
        name: "短桁A",
        corporateNumber: "123456789012", // 12桁
      }),
      makeOwner({
        id: "22222222-2222-4222-8222-222222222222",
        name: "短桁B",
        corporateNumber: "123456789012", // 12桁
      }),
      makeOwner({
        id: "33333333-3333-4333-8333-333333333333",
        name: "null持ち",
        corporateNumber: null,
      }),
      makeOwner({
        id: "44444444-4444-4444-8444-444444444444",
        name: "空文字持ち",
        corporateNumber: "",
      }),
    ]);

    const res = await GET(makeRequest("duplicate"));
    const json = await res.json();
    // 12桁同士でも duplicate にしない
    expect(json.candidates).toHaveLength(0);
  });

  it("複数の corporate_number グループに dup-cn-1, dup-cn-2 が連番付与される", async () => {
    pm.owner.findMany.mockResolvedValue([
      makeOwner({
        id: "11111111-1111-4111-8111-111111111111",
        name: "GA-1",
        corporateNumber: CN_VALID_A,
      }),
      makeOwner({
        id: "22222222-2222-4222-8222-222222222222",
        name: "GA-2",
        corporateNumber: CN_VALID_A,
      }),
      makeOwner({
        id: "33333333-3333-4333-8333-333333333333",
        name: "GB-1",
        corporateNumber: CN_VALID_B,
      }),
      makeOwner({
        id: "44444444-4444-4444-8444-444444444444",
        name: "GB-2",
        corporateNumber: CN_VALID_B,
      }),
    ]);

    const res = await GET(makeRequest("duplicate"));
    const json = await res.json();
    const ids = new Set(
      (json.candidates as { duplicateGroupId: string }[]).map(
        (c) => c.duplicateGroupId,
      ),
    );
    expect(ids.size).toBe(2);
    expect(Array.from(ids).every((id) => /^dup-cn-\d+$/.test(id))).toBe(true);
  });

  it("opaque ID と AuditLog detail に corporateNumber 生値が一切入らない", async () => {
    pm.owner.findMany.mockResolvedValue([
      makeOwner({
        id: "11111111-1111-4111-8111-111111111111",
        name: "CN-A",
        corporateNumber: CN_VALID_A,
      }),
      makeOwner({
        id: "22222222-2222-4222-8222-222222222222",
        name: "CN-B",
        corporateNumber: CN_VALID_A,
      }),
    ]);
    const { writeAuditLog } = await import("@/lib/audit");
    const res = await GET(makeRequest("duplicate"));
    const json = await res.json();
    for (const c of json.candidates as { duplicateGroupId: string }[]) {
      expect(c.duplicateGroupId).not.toContain(CN_VALID_A);
    }
    const auditCall = vi.mocked(writeAuditLog).mock.calls[0]?.[0];
    const serialized = JSON.stringify(auditCall!.detail);
    expect(serialized).not.toContain(CN_VALID_A);
  });
});

describe("GET correction-candidates: Phase 2-A duplicate by external_link_key", () => {
  const ELK_A = "EXT-LINK-001";
  const ELK_B = "EXT-LINK-002";

  it("同じ externalLinkKey を持つ owner ペアは duplicate 化される（dup-elk-N / matchedBy=external_link_key）", async () => {
    pm.owner.findMany.mockResolvedValue([
      makeOwner({
        id: "11111111-1111-4111-8111-111111111111",
        name: "L-1",
        address: "別住所",
        externalLinkKey: ELK_A,
      }),
      makeOwner({
        id: "22222222-2222-4222-8222-222222222222",
        name: "L-2",
        address: "別住所2",
        externalLinkKey: ELK_A,
      }),
    ]);

    const res = await GET(makeRequest("duplicate"));
    const json = await res.json();
    expect(json.candidates).toHaveLength(2);
    expect(json.candidates[0].duplicateGroupId).toMatch(/^dup-elk-\d+$/);
    expect(json.candidates[0].duplicateGroupId).toBe(
      json.candidates[1].duplicateGroupId,
    );
    expect(json.candidates[0].duplicateMatchedBy).toBe("external_link_key");
    expect(json.candidates[1].duplicateMatchedBy).toBe("external_link_key");
  });

  it("null / 空文字 / 空白のみ externalLinkKey は duplicate にならない", async () => {
    pm.owner.findMany.mockResolvedValue([
      makeOwner({
        id: "11111111-1111-4111-8111-111111111111",
        name: "X-1",
        externalLinkKey: null,
      }),
      makeOwner({
        id: "22222222-2222-4222-8222-222222222222",
        name: "X-2",
        externalLinkKey: "",
      }),
      makeOwner({
        id: "33333333-3333-4333-8333-333333333333",
        name: "X-3",
        externalLinkKey: "   ",
      }),
    ]);
    const res = await GET(makeRequest("duplicate"));
    const json = await res.json();
    expect(json.candidates).toHaveLength(0);
  });

  it("複数の external_link_key グループに dup-elk-1, dup-elk-2 が連番付与される", async () => {
    pm.owner.findMany.mockResolvedValue([
      makeOwner({
        id: "11111111-1111-4111-8111-111111111111",
        name: "A1",
        externalLinkKey: ELK_A,
      }),
      makeOwner({
        id: "22222222-2222-4222-8222-222222222222",
        name: "A2",
        externalLinkKey: ELK_A,
      }),
      makeOwner({
        id: "33333333-3333-4333-8333-333333333333",
        name: "B1",
        externalLinkKey: ELK_B,
      }),
      makeOwner({
        id: "44444444-4444-4444-8444-444444444444",
        name: "B2",
        externalLinkKey: ELK_B,
      }),
    ]);
    const res = await GET(makeRequest("duplicate"));
    const json = await res.json();
    const ids = new Set(
      (json.candidates as { duplicateGroupId: string }[]).map(
        (c) => c.duplicateGroupId,
      ),
    );
    expect(ids.size).toBe(2);
    expect(Array.from(ids).every((id) => /^dup-elk-\d+$/.test(id))).toBe(true);
  });

  it("opaque ID と AuditLog detail に externalLinkKey 生値が一切入らない", async () => {
    pm.owner.findMany.mockResolvedValue([
      makeOwner({
        id: "11111111-1111-4111-8111-111111111111",
        name: "EK-1",
        externalLinkKey: ELK_A,
      }),
      makeOwner({
        id: "22222222-2222-4222-8222-222222222222",
        name: "EK-2",
        externalLinkKey: ELK_A,
      }),
    ]);
    const { writeAuditLog } = await import("@/lib/audit");
    const res = await GET(makeRequest("duplicate"));
    const json = await res.json();
    for (const c of json.candidates as { duplicateGroupId: string }[]) {
      expect(c.duplicateGroupId).not.toContain(ELK_A);
    }
    const auditCall = vi.mocked(writeAuditLog).mock.calls[0]?.[0];
    const serialized = JSON.stringify(auditCall!.detail);
    expect(serialized).not.toContain(ELK_A);
  });

  it("summary.duplicateMatchedByCounts に経路別件数が含まれ、PII を含まない", async () => {
    pm.owner.findMany.mockResolvedValue([
      // name_address × 2
      makeOwner({
        id: "11111111-1111-4111-8111-111111111111",
        name: "同名",
        address: "同住所",
      }),
      makeOwner({
        id: "22222222-2222-4222-8222-222222222222",
        name: "同名",
        address: "同住所",
      }),
      // external_link_key × 2
      makeOwner({
        id: "33333333-3333-4333-8333-333333333333",
        name: "L1",
        externalLinkKey: ELK_A,
      }),
      makeOwner({
        id: "44444444-4444-4444-8444-444444444444",
        name: "L2",
        externalLinkKey: ELK_A,
      }),
    ]);
    const res = await GET(makeRequest("duplicate"));
    const json = await res.json();
    expect(json.summary.duplicateMatchedByCounts).toEqual({
      name_address: 2,
      corporate_number: 0,
      external_link_key: 2,
    });
    expect(JSON.stringify(json.summary)).not.toContain(ELK_A);
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

// ---- Codex P1: グループ割当 atomicity（孤立 group を作らない） ----
//
// 低優先グループのメンバーが高優先グループに既に割り当て済みの場合、
// 未割当が < 2 なら低優先 group を作らない。
// 未割当 >= 2 なら未割当だけで group を組み、size も未割当数に一致させる。
//
// これにより:
//   - 1 人だけの孤立 group が duplicate サマリーに混入しない
//   - duplicateGroupId を持つ候補は必ず同 ID 仲間 >= 2 が存在する
//   - duplicateGroupSize が実件数と完全一致する
//   - duplicateMatchedByCounts が実割当数と一致する
describe("GET correction-candidates: Codex P1 グループ割当 atomicity", () => {
  const CN_AB = "1234567890123";
  const CN_ABD = "9876543210987";
  const ELK_AB = "ELK-LINK-AB";

  it("ケース1: A-C name_address + A-B corporate_number → B だけの孤立 group は作られない", async () => {
    const ID_A = "11111111-1111-4111-8111-111111111111";
    const ID_B = "22222222-2222-4222-8222-222222222222";
    const ID_C = "33333333-3333-4333-8333-333333333333";
    pm.owner.findMany.mockResolvedValue([
      // A-C は name_address で重複
      makeOwner({ id: ID_A, name: "同名", address: "同住所", corporateNumber: CN_AB }),
      makeOwner({ id: ID_C, name: "同名", address: "同住所" }),
      // B は A と corporateNumber 共有だが name/address 違い
      makeOwner({ id: ID_B, name: "別名", address: "別住所", corporateNumber: CN_AB }),
    ]);

    const res = await GET(makeRequest("all"));
    const json = await res.json();
    const byId = new Map<string, { duplicateGroupId: string | null; duplicateGroupSize: number | null; duplicateMatchedBy: string | null; types: string[] }>(
      (json.candidates as { id: string; duplicateGroupId: string | null; duplicateGroupSize: number | null; duplicateMatchedBy: string | null; types: string[] }[]).map((c) => [c.id, c]),
    );

    // A / C は name_address で同 group
    expect(byId.get(ID_A)?.duplicateGroupId).toBe(byId.get(ID_C)?.duplicateGroupId);
    expect(byId.get(ID_A)?.duplicateMatchedBy).toBe("name_address");
    expect(byId.get(ID_A)?.duplicateGroupSize).toBe(2);

    // B は孤立 group を作られない（duplicateGroupId=null / types に "duplicate" なし）
    expect(byId.get(ID_B)?.duplicateGroupId).toBeNull();
    expect(byId.get(ID_B)?.duplicateGroupSize).toBeNull();
    expect(byId.get(ID_B)?.duplicateMatchedBy).toBeNull();
    expect(byId.get(ID_B)?.types).not.toContain("duplicate");
  });

  it("ケース2: A-C name_address + A-B-D corporate_number → B-D だけで dup-cn-1 / size=2", async () => {
    const ID_A = "11111111-1111-4111-8111-111111111111";
    const ID_B = "22222222-2222-4222-8222-222222222222";
    const ID_C = "33333333-3333-4333-8333-333333333333";
    const ID_D = "44444444-4444-4444-8444-444444444444";
    pm.owner.findMany.mockResolvedValue([
      makeOwner({ id: ID_A, name: "同名", address: "同住所", corporateNumber: CN_ABD }),
      makeOwner({ id: ID_C, name: "同名", address: "同住所" }),
      makeOwner({ id: ID_B, name: "B別名", address: "B別住所", corporateNumber: CN_ABD }),
      makeOwner({ id: ID_D, name: "D別名", address: "D別住所", corporateNumber: CN_ABD }),
    ]);

    const res = await GET(makeRequest("duplicate"));
    const json = await res.json();
    const byId = new Map<string, { duplicateGroupId: string | null; duplicateGroupSize: number | null; duplicateMatchedBy: string | null }>(
      (json.candidates as { id: string; duplicateGroupId: string | null; duplicateGroupSize: number | null; duplicateMatchedBy: string | null }[]).map((c) => [c.id, c]),
    );

    // A-C は name_address で同 group
    expect(byId.get(ID_A)?.duplicateMatchedBy).toBe("name_address");
    expect(byId.get(ID_C)?.duplicateMatchedBy).toBe("name_address");
    expect(byId.get(ID_A)?.duplicateGroupId).toBe(byId.get(ID_C)?.duplicateGroupId);

    // B-D は未割当だったので corporate_number で同 group / size=2
    expect(byId.get(ID_B)?.duplicateMatchedBy).toBe("corporate_number");
    expect(byId.get(ID_D)?.duplicateMatchedBy).toBe("corporate_number");
    expect(byId.get(ID_B)?.duplicateGroupId).toBe(byId.get(ID_D)?.duplicateGroupId);
    expect(byId.get(ID_B)?.duplicateGroupId).toMatch(/^dup-cn-\d+$/);
    expect(byId.get(ID_B)?.duplicateGroupSize).toBe(2);
    expect(byId.get(ID_D)?.duplicateGroupSize).toBe(2);
  });

  it("ケース3: external_link_key でも同様に未割当 < 2 なら group 化しない", async () => {
    const ID_A = "11111111-1111-4111-8111-111111111111";
    const ID_B = "22222222-2222-4222-8222-222222222222";
    const ID_C = "33333333-3333-4333-8333-333333333333";
    pm.owner.findMany.mockResolvedValue([
      // A-C name_address
      makeOwner({ id: ID_A, name: "同名", address: "同住所", externalLinkKey: ELK_AB }),
      makeOwner({ id: ID_C, name: "同名", address: "同住所" }),
      // B は A と externalLinkKey 共有
      makeOwner({ id: ID_B, name: "B別名", address: "B別住所", externalLinkKey: ELK_AB }),
    ]);

    const res = await GET(makeRequest("all"));
    const json = await res.json();
    const byId = new Map<string, { duplicateGroupId: string | null; types: string[] }>(
      (json.candidates as { id: string; duplicateGroupId: string | null; types: string[] }[]).map((c) => [c.id, c]),
    );

    // B は外部キー単独の孤立 group になっていない
    expect(byId.get(ID_B)?.duplicateGroupId).toBeNull();
    expect(byId.get(ID_B)?.types).not.toContain("duplicate");
  });

  it("整合性: duplicateGroupId を持つ全候補について、同 ID の仲間が必ず 2 件以上存在する", async () => {
    const ID_A = "11111111-1111-4111-8111-111111111111";
    const ID_B = "22222222-2222-4222-8222-222222222222";
    const ID_C = "33333333-3333-4333-8333-333333333333";
    const ID_D = "44444444-4444-4444-8444-444444444444";
    const ID_E = "55555555-5555-4555-8555-555555555555";
    pm.owner.findMany.mockResolvedValue([
      // name_address ペア
      makeOwner({ id: ID_A, name: "同名NA", address: "同住所NA" }),
      makeOwner({ id: ID_B, name: "同名NA", address: "同住所NA" }),
      // corporate_number ペア
      makeOwner({ id: ID_C, name: "CN1", corporateNumber: CN_AB }),
      makeOwner({ id: ID_D, name: "CN2", corporateNumber: CN_AB }),
      // 単独
      makeOwner({ id: ID_E, name: "孤独" }),
    ]);
    const res = await GET(makeRequest("duplicate"));
    const json = await res.json();

    const grouped = new Map<string, number>();
    for (const c of json.candidates as { duplicateGroupId: string | null }[]) {
      if (c.duplicateGroupId === null) continue;
      grouped.set(
        c.duplicateGroupId,
        (grouped.get(c.duplicateGroupId) ?? 0) + 1,
      );
    }
    for (const [id, count] of grouped.entries()) {
      expect(count).toBeGreaterThanOrEqual(2);
      // raw 値が opaque ID に混入していないこと
      expect(id).not.toContain(CN_AB);
      expect(id).not.toContain("同名NA");
      expect(id).not.toContain("同住所NA");
    }
  });

  it("整合性: duplicateGroupSize が同 groupId の実件数と一致する", async () => {
    pm.owner.findMany.mockResolvedValue([
      makeOwner({
        id: "11111111-1111-4111-8111-111111111111",
        name: "X",
        address: "Y",
        corporateNumber: CN_AB,
      }),
      makeOwner({
        id: "22222222-2222-4222-8222-222222222222",
        name: "X",
        address: "Y",
      }),
      // A-X-Y で name_address 重複（C は外）
      makeOwner({
        id: "33333333-3333-4333-8333-333333333333",
        name: "別",
        address: "別",
        corporateNumber: CN_AB,
      }),
      // B-C で corporate_number 共有だが、A は name_address で先取り、
      // 残り C 1 人のため corporate_number group は作られない想定
    ]);
    const res = await GET(makeRequest("duplicate"));
    const json = await res.json();
    const groupSizeMap = new Map<string, number>();
    for (const c of json.candidates as { duplicateGroupId: string | null }[]) {
      if (c.duplicateGroupId === null) continue;
      groupSizeMap.set(
        c.duplicateGroupId,
        (groupSizeMap.get(c.duplicateGroupId) ?? 0) + 1,
      );
    }
    for (const c of json.candidates as { duplicateGroupId: string | null; duplicateGroupSize: number | null }[]) {
      if (c.duplicateGroupId === null) continue;
      expect(c.duplicateGroupSize).toBe(
        groupSizeMap.get(c.duplicateGroupId),
      );
    }
  });

  it("整合性: summary.duplicateMatchedByCounts が実割当数と一致する", async () => {
    const ID_A = "11111111-1111-4111-8111-111111111111";
    const ID_B = "22222222-2222-4222-8222-222222222222";
    const ID_C = "33333333-3333-4333-8333-333333333333";
    const ID_D = "44444444-4444-4444-8444-444444444444";
    pm.owner.findMany.mockResolvedValue([
      // A-C name_address（CN AB 共有）
      makeOwner({ id: ID_A, name: "AC同名", address: "AC同住所", corporateNumber: CN_AB }),
      makeOwner({ id: ID_C, name: "AC同名", address: "AC同住所" }),
      // B は A と CN_AB 共有だが name/address 違い → 孤立 → group 化しない
      makeOwner({ id: ID_B, name: "B独自", address: "B独自", corporateNumber: CN_AB }),
      // D は単独
      makeOwner({ id: ID_D, name: "D独自", address: "D独自" }),
    ]);
    const res = await GET(makeRequest("duplicate"));
    const json = await res.json();

    // 実割当: name_address で A, C の 2 件のみ。corporate_number は孤立で 0。
    expect(json.summary.duplicateMatchedByCounts).toEqual({
      name_address: 2,
      corporate_number: 0,
      external_link_key: 0,
    });
    // duplicateCount も 2（types["duplicate"] 持ち）
    expect(json.summary.duplicateCount).toBe(2);
    // count 合計 = duplicateCount
    const counts = json.summary.duplicateMatchedByCounts;
    expect(counts.name_address + counts.corporate_number + counts.external_link_key).toBe(
      json.summary.duplicateCount,
    );
  });

  it("AuditLog detail に法人番号生値 / externalLinkKey 生値 / 氏名 / 住所が含まれない（孤立ケース含む）", async () => {
    const ID_A = "11111111-1111-4111-8111-111111111111";
    const ID_B = "22222222-2222-4222-8222-222222222222";
    const ID_C = "33333333-3333-4333-8333-333333333333";
    const PII_NAME = "PII氏名X";
    const PII_ADDR = "PII住所Y";
    pm.owner.findMany.mockResolvedValue([
      makeOwner({
        id: ID_A,
        name: PII_NAME,
        address: PII_ADDR,
        corporateNumber: CN_AB,
        externalLinkKey: ELK_AB,
      }),
      makeOwner({
        id: ID_C,
        name: PII_NAME,
        address: PII_ADDR,
      }),
      // 孤立になる B
      makeOwner({
        id: ID_B,
        name: "B別",
        address: "B別",
        corporateNumber: CN_AB,
        externalLinkKey: ELK_AB,
      }),
    ]);

    const { writeAuditLog } = await import("@/lib/audit");
    await GET(makeRequest("duplicate"));
    const auditCall = vi.mocked(writeAuditLog).mock.calls[0]?.[0];
    expect(auditCall).toBeDefined();
    const serialized = JSON.stringify(auditCall!.detail);
    expect(serialized).not.toContain(CN_AB);
    expect(serialized).not.toContain(ELK_AB);
    expect(serialized).not.toContain(PII_NAME);
    expect(serialized).not.toContain(PII_ADDR);
  });
});

// ---- Codex P2 (round 2): merge_candidate 昇格は name_address 限定 ----
//
// merge-preview API は buildOwnerDuplicateCandidateKey による name+address
// 検証しか持たないため、corporate_number / external_link_key 由来の duplicate
// 候補に recommendedAction="merge_candidate" を付けると UI で merge できそうに
// 見えて preview/execute が name_address_normalize_mismatch でブロックされる
// 機能不整合になる。route 側で merge_candidate 昇格を name_address 限定にする。
describe("GET correction-candidates: Codex P2 (round 2) merge_candidate scoping", () => {
  const CN_VALID = "1234567890123";
  const ELK = "EXT-LINK-001";

  it("name_address group の review 候補は merge_candidate に昇格する", async () => {
    pm.owner.findMany.mockResolvedValue([
      makeOwner({
        id: "11111111-1111-4111-8111-111111111111",
        name: "同名",
        address: "同住所",
      }),
      makeOwner({
        id: "22222222-2222-4222-8222-222222222222",
        name: "同名",
        address: "同住所",
      }),
    ]);
    const res = await GET(makeRequest("duplicate"));
    const json = await res.json();
    expect(json.candidates).toHaveLength(2);
    for (const c of json.candidates as { duplicateMatchedBy: string; recommendedAction: string }[]) {
      expect(c.duplicateMatchedBy).toBe("name_address");
      expect(c.recommendedAction).toBe("merge_candidate");
    }
  });

  it("corporate_number group の候補は merge_candidate に昇格しない（review のまま）", async () => {
    pm.owner.findMany.mockResolvedValue([
      makeOwner({
        id: "11111111-1111-4111-8111-111111111111",
        name: "CN社A",
        address: "住所A",
        corporateNumber: CN_VALID,
      }),
      makeOwner({
        id: "22222222-2222-4222-8222-222222222222",
        name: "CN社B",
        address: "住所B",
        corporateNumber: CN_VALID,
      }),
    ]);
    const res = await GET(makeRequest("duplicate"));
    const json = await res.json();
    expect(json.candidates).toHaveLength(2);
    for (const c of json.candidates as { duplicateMatchedBy: string; recommendedAction: string }[]) {
      expect(c.duplicateMatchedBy).toBe("corporate_number");
      // duplicate group には属するが、merge_candidate には昇格しない
      expect(c.recommendedAction).not.toBe("merge_candidate");
      // 既存の review / hold / delete_candidate のいずれか（このケースでは review）
      expect(c.recommendedAction).toBe("review");
    }
  });

  it("external_link_key group の候補は merge_candidate に昇格しない", async () => {
    pm.owner.findMany.mockResolvedValue([
      makeOwner({
        id: "11111111-1111-4111-8111-111111111111",
        name: "L1",
        address: "住所L1",
        externalLinkKey: ELK,
      }),
      makeOwner({
        id: "22222222-2222-4222-8222-222222222222",
        name: "L2",
        address: "住所L2",
        externalLinkKey: ELK,
      }),
    ]);
    const res = await GET(makeRequest("duplicate"));
    const json = await res.json();
    expect(json.candidates).toHaveLength(2);
    for (const c of json.candidates as { duplicateMatchedBy: string; recommendedAction: string; blockReasons: string[] }[]) {
      expect(c.duplicateMatchedBy).toBe("external_link_key");
      expect(c.recommendedAction).not.toBe("merge_candidate");
      // external_link_key が入っていると blockReasons に "external_link_key_exists" が
      // 入って hasSafeguard=true → recommendedAction="hold"
      expect(c.recommendedAction).toBe("hold");
      expect(c.blockReasons).toContain("external_link_key_exists");
    }
  });

  it("hasSafeguard 由来の hold は経路を問わず維持される（昇格対象外）", async () => {
    // note を持つ owner（hold 維持） + 同名同住所のもう 1 件。
    pm.owner.findMany.mockResolvedValue([
      makeOwner({
        id: "11111111-1111-4111-8111-111111111111",
        name: "メモ持ち",
        address: "同住所",
        note: "important note",
      }),
      makeOwner({
        id: "22222222-2222-4222-8222-222222222222",
        name: "メモ持ち",
        address: "同住所",
      }),
    ]);
    const res = await GET(makeRequest("duplicate"));
    const json = await res.json();
    const byId = new Map<string, { recommendedAction: string; duplicateMatchedBy: string }>(
      (json.candidates as { id: string; recommendedAction: string; duplicateMatchedBy: string }[]).map((c) => [c.id, c]),
    );
    // note 持ちは hasSafeguard=true → hold のまま（name_address group でも昇格しない）
    expect(byId.get("11111111-1111-4111-8111-111111111111")?.recommendedAction).toBe("hold");
    // メモなしの相方は review → merge_candidate に昇格
    expect(byId.get("22222222-2222-4222-8222-222222222222")?.recommendedAction).toBe("merge_candidate");
  });

  it("name_address の優先で corporate_number 経路を抑制されたケースでも、name_address 側だけ merge_candidate になる", async () => {
    const ID_A = "11111111-1111-4111-8111-111111111111";
    const ID_B = "22222222-2222-4222-8222-222222222222";
    const ID_C = "33333333-3333-4333-8333-333333333333";
    const ID_D = "44444444-4444-4444-8444-444444444444";
    pm.owner.findMany.mockResolvedValue([
      // A-C: name_address
      makeOwner({ id: ID_A, name: "AC同名", address: "AC同住所", corporateNumber: CN_VALID }),
      makeOwner({ id: ID_C, name: "AC同名", address: "AC同住所" }),
      // B-D: corporate_number のみ（name/address 違い）
      makeOwner({ id: ID_B, name: "B独自", address: "B独自", corporateNumber: CN_VALID }),
      makeOwner({ id: ID_D, name: "D独自", address: "D独自", corporateNumber: CN_VALID }),
    ]);
    const res = await GET(makeRequest("duplicate"));
    const json = await res.json();
    const byId = new Map<string, { recommendedAction: string; duplicateMatchedBy: string }>(
      (json.candidates as { id: string; recommendedAction: string; duplicateMatchedBy: string }[]).map((c) => [c.id, c]),
    );
    // A-C は name_address → merge_candidate
    expect(byId.get(ID_A)?.recommendedAction).toBe("merge_candidate");
    expect(byId.get(ID_C)?.recommendedAction).toBe("merge_candidate");
    // B-D は corporate_number → review のまま（昇格しない）
    expect(byId.get(ID_B)?.recommendedAction).toBe("review");
    expect(byId.get(ID_D)?.recommendedAction).toBe("review");
    expect(byId.get(ID_B)?.duplicateMatchedBy).toBe("corporate_number");
    expect(byId.get(ID_D)?.duplicateMatchedBy).toBe("corporate_number");
  });
});
