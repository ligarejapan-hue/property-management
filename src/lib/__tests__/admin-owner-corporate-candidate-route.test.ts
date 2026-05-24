/**
 * GET /api/admin/owners/[id]/corporate-candidate (Phase F) のルートテスト。
 *
 * - 認可（401 / 403）
 * - 法人番号権限 hidden → 403
 * - archived / not found → 404
 * - missing / same / conflict / multi 分類
 * - note hidden/masked/partial は検出対象外
 * - display-level マスキング (full/edit/read/masked/partial)
 * - AuditLog detail に法人番号生値・会社名・住所・note 本文・候補リストが含まれない
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
      email: "a@a",
      name: "A",
      role: "admin",
    }),
    getUserPermissions: vi.fn(),
    getOwnerDisplayConfig: vi.fn(),
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
    owner: { findUnique: vi.fn() },
  },
}));

import prisma from "@/lib/prisma";
import {
  getUserPermissions,
  getOwnerDisplayConfig,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { GET } from "../../app/api/admin/owners/[id]/corporate-candidate/route";

const pm = prisma as unknown as {
  owner: { findUnique: Mock };
};

const OWNER_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const CN = "1234567890123";
const CN_OTHER = "9876543210123";
const RAW_NAME = "山田太郎";
const RAW_ADDR = "東京都千代田区丸の内1-1-1";
const RAW_NOTE = "memo with secret 1234567890123";

const PERMS_FULL = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "owner_name", action: "full", granted: true },
  { resource: "owner_address", action: "full", granted: true },
  { resource: "owner_corporate_number", action: "full", granted: true },
];

const DISPLAY_FULL = {
  name: "full" as const,
  nameKana: "full" as const,
  phone: "full" as const,
  zip: "full" as const,
  address: "full" as const,
  note: "full" as const,
  email: "full" as const,
  corporateNumber: "full" as const,
};

function makeParams() {
  return { params: Promise.resolve({ id: OWNER_ID }) };
}

function makeRequest() {
  return new Request(
    `http://localhost/api/admin/owners/${OWNER_ID}/corporate-candidate`,
  ) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL);
  vi.mocked(getOwnerDisplayConfig).mockResolvedValue(DISPLAY_FULL);
  pm.owner.findUnique.mockResolvedValue({
    id: OWNER_ID,
    name: `株式会社 ${CN}`,
    address: null,
    note: null,
    corporateNumber: null,
    version: 1,
    isArchived: false,
    _count: { propertyOwners: 0 },
  });
});

describe("GET /admin/owners/[id]/corporate-candidate — 認可", () => {
  it("user_management:read 無しで 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValueOnce([
      { resource: "owner", action: "read", granted: true },
    ]);
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(403);
    expect(pm.owner.findUnique).not.toHaveBeenCalled();
  });

  it("owner:read 無しで 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValueOnce([
      { resource: "user_management", action: "read", granted: true },
    ]);
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(403);
    expect(pm.owner.findUnique).not.toHaveBeenCalled();
  });

  it("owner_corporate_number=hidden で 403", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValueOnce({
      ...DISPLAY_FULL,
      corporateNumber: "hidden",
    });
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(403);
    expect(pm.owner.findUnique).not.toHaveBeenCalled();
  });
});

describe("GET /admin/owners/[id]/corporate-candidate — owner 状態", () => {
  it("owner not found で 404", async () => {
    pm.owner.findUnique.mockResolvedValueOnce(null);
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(404);
  });

  it("archived owner で 404", async () => {
    pm.owner.findUnique.mockResolvedValueOnce({
      id: OWNER_ID,
      name: "x",
      address: null,
      note: null,
      corporateNumber: null,
      version: 1,
      isArchived: true,
      _count: { propertyOwners: 0 },
    });
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(404);
  });

  it("owner overview を返す（候補なしでも 200）", async () => {
    pm.owner.findUnique.mockResolvedValueOnce({
      id: OWNER_ID,
      name: "山田太郎",
      address: "東京都千代田区",
      note: null,
      corporateNumber: null,
      version: 3,
      isArchived: false,
      _count: { propertyOwners: 2 },
    });
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.owner.ownerId).toBe(OWNER_ID);
    expect(json.owner.version).toBe(3);
    expect(json.owner.propertyOwnerCount).toBe(2);
    expect(json.candidate).toBeNull();
  });
});

describe("GET /admin/owners/[id]/corporate-candidate — 分類", () => {
  it("missing: 候補1件 + existing=null", async () => {
    pm.owner.findUnique.mockResolvedValueOnce({
      id: OWNER_ID,
      name: `A社 法人番号:${CN}`,
      address: null,
      note: null,
      corporateNumber: null,
      version: 1,
      isArchived: false,
      _count: { propertyOwners: 0 },
    });
    const res = await GET(makeRequest(), makeParams());
    const json = await res.json();
    expect(json.candidate.type).toBe("missing");
    expect(json.candidate.candidateCorporateNumberMasked).toBe(CN);
  });

  it("same: 候補1件 + existing 同一", async () => {
    pm.owner.findUnique.mockResolvedValueOnce({
      id: OWNER_ID,
      name: `B社 ${CN}`,
      address: null,
      note: null,
      corporateNumber: CN,
      version: 1,
      isArchived: false,
      _count: { propertyOwners: 0 },
    });
    const res = await GET(makeRequest(), makeParams());
    const json = await res.json();
    expect(json.candidate.type).toBe("same");
  });

  it("conflict: 候補1件 + existing 異なる", async () => {
    pm.owner.findUnique.mockResolvedValueOnce({
      id: OWNER_ID,
      name: `C社 ${CN}`,
      address: null,
      note: null,
      corporateNumber: CN_OTHER,
      version: 1,
      isArchived: false,
      _count: { propertyOwners: 0 },
    });
    const res = await GET(makeRequest(), makeParams());
    const json = await res.json();
    expect(json.candidate.type).toBe("conflict");
  });

  it("multi: 候補複数（candidate 値は null）", async () => {
    pm.owner.findUnique.mockResolvedValueOnce({
      id: OWNER_ID,
      name: `D社 法人番号:${CN}`,
      address: `addr ${CN_OTHER}`,
      note: null,
      corporateNumber: null,
      version: 1,
      isArchived: false,
      _count: { propertyOwners: 0 },
    });
    const res = await GET(makeRequest(), makeParams());
    const json = await res.json();
    expect(json.candidate.type).toBe("multi");
    expect(json.candidate.candidateCorporateNumberMasked).toBeNull();
  });
});

describe("GET /admin/owners/[id]/corporate-candidate — note gate (raw-visible)", () => {
  beforeEach(() => {
    pm.owner.findUnique.mockResolvedValue({
      id: OWNER_ID,
      name: "山田太郎",
      address: null,
      note: `法人番号:${CN}`,
      corporateNumber: null,
      version: 1,
      isArchived: false,
      _count: { propertyOwners: 0 },
    });
  });

  it("note=hidden では note のみの法人番号は候補にならない", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValueOnce({
      ...DISPLAY_FULL,
      note: "hidden",
    });
    const res = await GET(makeRequest(), makeParams());
    const json = await res.json();
    expect(json.candidate).toBeNull();
  });

  it("note=masked では note のみの法人番号は候補にならない", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValueOnce({
      ...DISPLAY_FULL,
      note: "masked",
    });
    const res = await GET(makeRequest(), makeParams());
    const json = await res.json();
    expect(json.candidate).toBeNull();
  });

  it("note=partial では note のみの法人番号は候補にならない", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValueOnce({
      ...DISPLAY_FULL,
      note: "partial",
    });
    const res = await GET(makeRequest(), makeParams());
    const json = await res.json();
    expect(json.candidate).toBeNull();
  });

  it("note=full では候補化される、detectedIn=['note']", async () => {
    const res = await GET(makeRequest(), makeParams());
    const json = await res.json();
    expect(json.candidate.type).toBe("missing");
    expect(json.candidate.detectedIn).toEqual(["note"]);
  });
});

describe("GET /admin/owners/[id]/corporate-candidate — display-level マスキング", () => {
  it("corporateNumber=full → existing は生値", async () => {
    pm.owner.findUnique.mockResolvedValueOnce({
      id: OWNER_ID,
      name: "山田太郎",
      address: null,
      note: null,
      corporateNumber: CN,
      version: 1,
      isArchived: false,
      _count: { propertyOwners: 0 },
    });
    const res = await GET(makeRequest(), makeParams());
    const json = await res.json();
    expect(json.owner.existingCorporateNumberMasked).toBe(CN);
  });

  it("corporateNumber=edit/read/masked/partial → existing はマスク", async () => {
    for (const lv of ["edit", "read", "masked", "partial"] as const) {
      vi.mocked(getOwnerDisplayConfig).mockResolvedValueOnce({
        ...DISPLAY_FULL,
        corporateNumber: lv,
      });
      pm.owner.findUnique.mockResolvedValueOnce({
        id: OWNER_ID,
        name: "山田太郎",
        address: null,
        note: null,
        corporateNumber: CN,
        version: 1,
        isArchived: false,
        _count: { propertyOwners: 0 },
      });
      const res = await GET(makeRequest(), makeParams());
      const json = await res.json();
      expect(json.owner.existingCorporateNumberMasked).not.toBe(CN);
      expect(json.owner.existingCorporateNumberMasked).toMatch(/^\d{4}\*+$/);
    }
  });
});

describe("GET /admin/owners/[id]/corporate-candidate — AuditLog PII 防止", () => {
  it("detail に 法人番号生値・会社名・住所・note 本文・候補リストが含まれない", async () => {
    pm.owner.findUnique.mockResolvedValueOnce({
      id: OWNER_ID,
      name: `${RAW_NAME} 法人番号:${CN}`,
      address: RAW_ADDR,
      note: RAW_NOTE,
      corporateNumber: CN_OTHER,
      version: 1,
      isArchived: false,
      _count: { propertyOwners: 0 },
    });
    await GET(makeRequest(), makeParams());
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalledOnce();
    const call = vi.mocked(writeAuditLog).mock.calls[0][0];
    expect(call.action).toBe("owner_correction_corporate_candidate_view");
    expect(call.targetTable).toBe("owners");
    expect(call.targetId).toBe(OWNER_ID);
    const detailJson = JSON.stringify(call.detail);
    expect(detailJson).not.toContain(CN);
    expect(detailJson).not.toContain(CN_OTHER);
    expect(detailJson).not.toContain(RAW_NAME);
    expect(detailJson).not.toContain(RAW_ADDR);
    expect(detailJson).not.toContain(RAW_NOTE);
    expect(detailJson).not.toContain("secret");
    // 入っていてよいキーのみ
    expect(call.detail).toHaveProperty("hasCandidate");
    expect(call.detail).toHaveProperty("type");
    expect(call.detail).toHaveProperty("detectedInCount");
  });
});
