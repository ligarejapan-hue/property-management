/**
 * GET /api/admin/owners/correction/corporate-number-candidates のルートテスト（Phase E）。
 *
 * 検証観点:
 * - 認証 / 認可（401 / 403）
 * - type フィルタ（missing / conflict / multi / same / all）
 * - archived owner は出ない
 * - cursor / limit / hasNextPage / nextCursor
 * - limit > 200 は 200 に丸める
 * - summary が返る（missing / conflict / multi / same / totalCandidates）
 * - AuditLog detail に Owner.id 配列・法人番号生値・会社名・住所・note が含まれない
 * - display-level に応じて法人番号がマスクされる（full / masked / hidden）
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
    owner: { findMany: vi.fn() },
  },
}));

import prisma from "@/lib/prisma";
import {
  getUserPermissions,
  getOwnerDisplayConfig,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { GET } from "../../app/api/admin/owners/correction/corporate-number-candidates/route";

const pm = prisma as unknown as {
  owner: { findMany: Mock };
};

const CN = "1234567890123";
const CN_OTHER = "9876543210123";
const RAW_NAME = "山田太郎";
const RAW_ADDR = "東京都千代田区丸の内1-1-1";
const RAW_NOTE = "memo with 1234567890123";

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

function url(query: string = "") {
  return new Request(
    `http://localhost/api/admin/owners/correction/corporate-number-candidates${query}`,
  ) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL);
  vi.mocked(getOwnerDisplayConfig).mockResolvedValue(DISPLAY_FULL);
  pm.owner.findMany.mockResolvedValue([]);
});

describe("GET /corporate-number-candidates — 認可", () => {
  it("user_management:read 無しで 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValueOnce([
      { resource: "owner", action: "read", granted: true },
    ]);
    const res = await GET(url());
    expect(res.status).toBe(403);
  });

  it("owner:read 無しで 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValueOnce([
      { resource: "user_management", action: "read", granted: true },
    ]);
    const res = await GET(url());
    expect(res.status).toBe(403);
  });
});

describe("GET /corporate-number-candidates — 分類", () => {
  beforeEach(() => {
    pm.owner.findMany.mockResolvedValue([
      // missing: existing null, 候補1件
      {
        id: "o-1",
        name: `A社 法人番号:${CN}`,
        address: null,
        note: null,
        corporateNumber: null,
        version: 1,
      },
      // same: existing 同一、候補1件
      {
        id: "o-2",
        name: `B社 ${CN}`,
        address: null,
        note: null,
        corporateNumber: CN,
        version: 1,
      },
      // conflict: existing 異なる、候補1件
      {
        id: "o-3",
        name: `C社 ${CN}`,
        address: null,
        note: null,
        corporateNumber: CN_OTHER,
        version: 1,
      },
      // multi: 候補複数
      {
        id: "o-4",
        name: `D社 法人番号:${CN}`,
        address: `note ${CN_OTHER}`,
        note: null,
        corporateNumber: null,
        version: 1,
      },
      // 候補なし → 結果に含まれない
      {
        id: "o-5",
        name: "なし太郎",
        address: null,
        note: null,
        corporateNumber: null,
        version: 1,
      },
    ]);
  });

  it("type=all のデフォルトは missing/conflict/multi（same を除外）", async () => {
    const res = await GET(url());
    expect(res.status).toBe(200);
    const json = await res.json();
    const types = json.candidates.map((c: { type: string }) => c.type).sort();
    expect(types).toEqual(["conflict", "missing", "multi"]);
  });

  it("type=missing で missing のみ", async () => {
    const res = await GET(url("?type=missing"));
    const json = await res.json();
    const types = json.candidates.map((c: { type: string }) => c.type);
    expect(types).toEqual(["missing"]);
    expect(json.candidates[0].ownerId).toBe("o-1");
  });

  it("type=conflict で conflict のみ", async () => {
    const res = await GET(url("?type=conflict"));
    const json = await res.json();
    expect(json.candidates).toHaveLength(1);
    expect(json.candidates[0].type).toBe("conflict");
  });

  it("type=multi で multi のみ", async () => {
    const res = await GET(url("?type=multi"));
    const json = await res.json();
    expect(json.candidates).toHaveLength(1);
    expect(json.candidates[0].type).toBe("multi");
  });

  it("type=same で same のみ（サブフィルタ）", async () => {
    const res = await GET(url("?type=same"));
    const json = await res.json();
    expect(json.candidates).toHaveLength(1);
    expect(json.candidates[0].type).toBe("same");
  });

  it("summary が all owners ベースで返る", async () => {
    const res = await GET(url());
    const json = await res.json();
    expect(json.summary).toEqual({
      missing: 1,
      same: 1,
      conflict: 1,
      multi: 1,
      totalCandidates: 4,
    });
  });

  it("候補 0 件の owner は結果に含まれない", async () => {
    const res = await GET(url());
    const json = await res.json();
    expect(json.candidates.find((c: { ownerId: string }) => c.ownerId === "o-5")).toBeUndefined();
  });
});

describe("GET /corporate-number-candidates — archived owner", () => {
  it("archived は findMany の where で除外（route が isArchived: false を渡す）", async () => {
    pm.owner.findMany.mockResolvedValue([]);
    await GET(url());
    expect(pm.owner.findMany).toHaveBeenCalledOnce();
    const arg = pm.owner.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ isArchived: false });
  });
});

describe("GET /corporate-number-candidates — pagination", () => {
  beforeEach(() => {
    pm.owner.findMany.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({
        id: `o-${i.toString().padStart(2, "0")}`,
        name: `社${i} 法人番号:${CN}`,
        address: null,
        note: null,
        corporateNumber: null,
        version: 1,
      })),
    );
  });

  it("limit=2 で 2 件返り、hasNextPage=true / nextCursor が末尾 ownerId", async () => {
    const res = await GET(url("?limit=2"));
    const json = await res.json();
    expect(json.candidates).toHaveLength(2);
    expect(json.hasNextPage).toBe(true);
    expect(json.nextCursor).toBe(json.candidates[1].ownerId);
  });

  it("cursor で続きを取得できる", async () => {
    const res1 = await GET(url("?limit=2"));
    const json1 = await res1.json();
    const res2 = await GET(url(`?limit=2&cursor=${json1.nextCursor}`));
    const json2 = await res2.json();
    expect(json2.candidates).toHaveLength(2);
    expect(json2.candidates[0].ownerId > json1.nextCursor).toBe(true);
  });

  it("limit > 200 は 200 に丸める", async () => {
    const res = await GET(url("?limit=500"));
    const json = await res.json();
    // candidates が 5 件しかないので全件返る、ただし内部 limit は 200 にクランプ
    expect(json.candidates).toHaveLength(5);
    expect(json.hasNextPage).toBe(false);
  });

  it("最終ページ は hasNextPage=false", async () => {
    const res = await GET(url("?limit=10"));
    const json = await res.json();
    expect(json.hasNextPage).toBe(false);
    expect(json.nextCursor).toBeNull();
  });
});

describe("GET /corporate-number-candidates — display-level マスキング", () => {
  it("owner_corporate_number=full → 法人番号生値返却", async () => {
    pm.owner.findMany.mockResolvedValue([
      {
        id: "o-1",
        name: `株式会社 ${CN}`,
        address: null,
        note: null,
        corporateNumber: null,
        version: 1,
      },
    ]);
    const res = await GET(url("?type=missing"));
    const json = await res.json();
    expect(json.candidates[0].candidateCorporateNumberMasked).toBe(CN);
  });

  it("owner_corporate_number=masked → 先頭4桁マスク（生値が出ない）", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValueOnce({
      ...DISPLAY_FULL,
      corporateNumber: "masked",
    });
    pm.owner.findMany.mockResolvedValue([
      {
        id: "o-1",
        name: `株式会社 ${CN}`,
        address: null,
        note: null,
        corporateNumber: CN_OTHER,
        version: 1,
      },
    ]);
    const res = await GET(url("?type=conflict"));
    const json = await res.json();
    const row = json.candidates[0];
    expect(row.candidateCorporateNumberMasked).not.toBe(CN);
    expect(row.candidateCorporateNumberMasked).toMatch(/^\d{4}\*+$/);
    expect(row.existingCorporateNumberMasked).not.toBe(CN_OTHER);
  });

  it("owner_corporate_number=edit → 法人番号はマスク（事前確定方針: full のみ生値）", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValueOnce({
      ...DISPLAY_FULL,
      corporateNumber: "edit",
    });
    pm.owner.findMany.mockResolvedValue([
      {
        id: "o-1",
        name: `株式会社 ${CN}`,
        address: null,
        note: null,
        corporateNumber: CN_OTHER,
        version: 1,
      },
    ]);
    const res = await GET(url("?type=conflict"));
    const json = await res.json();
    const row = json.candidates[0];
    expect(row.candidateCorporateNumberMasked).not.toBe(CN);
    expect(row.candidateCorporateNumberMasked).toMatch(/^\d{4}\*+$/);
    expect(row.existingCorporateNumberMasked).not.toBe(CN_OTHER);
    expect(row.existingCorporateNumberMasked).toMatch(/^\d{4}\*+$/);
  });

  it("owner_corporate_number=read → 法人番号はマスク（事前確定方針: full のみ生値）", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValueOnce({
      ...DISPLAY_FULL,
      corporateNumber: "read",
    });
    pm.owner.findMany.mockResolvedValue([
      {
        id: "o-1",
        name: `株式会社 ${CN}`,
        address: null,
        note: null,
        corporateNumber: CN_OTHER,
        version: 1,
      },
    ]);
    const res = await GET(url("?type=conflict"));
    const json = await res.json();
    const row = json.candidates[0];
    expect(row.candidateCorporateNumberMasked).not.toBe(CN);
    expect(row.candidateCorporateNumberMasked).toMatch(/^\d{4}\*+$/);
    expect(row.existingCorporateNumberMasked).not.toBe(CN_OTHER);
    expect(row.existingCorporateNumberMasked).toMatch(/^\d{4}\*+$/);
  });

  it("owner_corporate_number=partial → 法人番号はマスク", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValueOnce({
      ...DISPLAY_FULL,
      corporateNumber: "partial",
    });
    pm.owner.findMany.mockResolvedValue([
      {
        id: "o-1",
        name: `株式会社 ${CN}`,
        address: null,
        note: null,
        corporateNumber: CN_OTHER,
        version: 1,
      },
    ]);
    const res = await GET(url("?type=conflict"));
    const json = await res.json();
    const row = json.candidates[0];
    expect(row.candidateCorporateNumberMasked).toMatch(/^\d{4}\*+$/);
    expect(row.existingCorporateNumberMasked).toMatch(/^\d{4}\*+$/);
  });

  it("owner_corporate_number=hidden → 法人番号フィールドは null", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValueOnce({
      ...DISPLAY_FULL,
      corporateNumber: "hidden",
    });
    pm.owner.findMany.mockResolvedValue([
      {
        id: "o-1",
        name: `株式会社 ${CN}`,
        address: null,
        note: null,
        corporateNumber: CN_OTHER,
        version: 1,
      },
    ]);
    const res = await GET(url("?type=conflict"));
    const json = await res.json();
    const row = json.candidates[0];
    expect(row.candidateCorporateNumberMasked).toBeNull();
    expect(row.existingCorporateNumberMasked).toBeNull();
  });
});

describe("GET /corporate-number-candidates — AuditLog PII 漏洩防止", () => {
  beforeEach(() => {
    pm.owner.findMany.mockResolvedValue([
      {
        id: "o-1",
        name: `${RAW_NAME} 法人番号:${CN}`,
        address: RAW_ADDR,
        note: RAW_NOTE,
        corporateNumber: null,
        version: 1,
      },
    ]);
  });

  it("AuditLog detail に Owner.id 配列・法人番号生値・会社名・住所・note・候補リストが含まれない", async () => {
    await GET(url("?type=missing"));
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalledOnce();
    const call = vi.mocked(writeAuditLog).mock.calls[0][0];
    expect(call.action).toBe("owner_correction_corporate_candidates_list");
    const detailJson = JSON.stringify(call.detail);
    expect(detailJson).not.toContain(CN);
    expect(detailJson).not.toContain(RAW_NAME);
    expect(detailJson).not.toContain(RAW_ADDR);
    expect(detailJson).not.toContain(RAW_NOTE);
    expect(detailJson).not.toContain("o-1"); // Owner.id 配列も入れない
    expect(call.detail).toHaveProperty("type");
    expect(call.detail).toHaveProperty("resultCount");
    expect(call.detail).toHaveProperty("summary");
    expect(call.detail).toHaveProperty("hasNextPage");
  });
});

describe("GET /corporate-number-candidates — detailUrl", () => {
  it("detailUrl は /admin/owners/{ownerId}", async () => {
    pm.owner.findMany.mockResolvedValue([
      {
        id: "abc-123",
        name: `株式会社 ${CN}`,
        address: null,
        note: null,
        corporateNumber: null,
        version: 1,
      },
    ]);
    const res = await GET(url("?type=missing"));
    const json = await res.json();
    expect(json.candidates[0].detailUrl).toBe("/admin/owners/abc-123");
  });
});
