/**
 * POST /api/owners/[id]/corporate-lookup ルートテスト。
 *
 * - 13桁正常で 200 (found / closed)
 * - ハイフン・空白・全角混じりを正規化して lookup
 * - 12桁 / 14桁は 422
 * - owner:read 無しで 403
 * - owner_corporate_number edit/full 無しで 403
 * - owner not found で 404
 * - archived owner で 404
 * - env 未設定で 503
 * - 上流 5xx で 502
 * - DB 更新が発生しない（owner.update が呼ばれない）
 * - AuditLog に法人番号生値・会社名・所在地・raw XML が含まれない
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
    owner: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock("@/lib/corporate-lookup", async () => {
  const actual = await vi.importActual<typeof import("@/lib/corporate-lookup")>(
    "@/lib/corporate-lookup",
  );
  return {
    ...actual,
    lookupCorporateNumber: vi.fn(),
  };
});

import prisma from "@/lib/prisma";
import { getUserPermissions } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import {
  lookupCorporateNumber,
  CorporateLookupError,
} from "@/lib/corporate-lookup";
import { POST } from "../../app/api/owners/[id]/corporate-lookup/route";

const pm = prisma as unknown as {
  owner: {
    findUnique: Mock;
    update: Mock;
    updateMany: Mock;
    create: Mock;
  };
};

const OWNER_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const RAW_NUMBER = "1234567890123";
const RAW_NAME = "○○株式会社";
const RAW_ADDRESS = "東京都千代田区丸の内１−１−１";

const PERMS_FULL = [
  { resource: "owner", action: "read", granted: true },
  { resource: "owner_corporate_number", action: "full", granted: true },
];
const PERMS_NO_OWNER_READ = [
  { resource: "owner_corporate_number", action: "full", granted: true },
];
const PERMS_NO_CORP_WRITE = [
  { resource: "owner", action: "read", granted: true },
  // owner_corporate_number は付与しない
];

function makeRequest(body: unknown) {
  return new Request(`http://localhost/api/owners/${OWNER_ID}/corporate-lookup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}
const makeParams = () => ({ params: Promise.resolve({ id: OWNER_ID }) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL);
  pm.owner.findUnique.mockResolvedValue({ id: OWNER_ID, isArchived: false });
  vi.mocked(lookupCorporateNumber).mockResolvedValue({
    found: true,
    isClosed: false,
    closeDate: null,
    closeCause: null,
    record: {
      corporateNumber: RAW_NUMBER,
      name: RAW_NAME,
      furigana: "○○カブシキガイシャ",
      address: RAW_ADDRESS,
      prefectureName: "東京都",
      cityName: "千代田区",
      streetNumber: "丸の内１−１−１",
      postCode: "1000005",
      updateDate: "2025-04-01",
    },
    fetchedAt: "2026-05-22T07:30:00.000Z",
    source: "nta-houjin-bangou-v4",
  });
});

describe("POST /api/owners/[id]/corporate-lookup — 正常系", () => {
  it("13桁正常で 200 found=true", async () => {
    const res = await POST(makeRequest({ corporateNumber: RAW_NUMBER }), makeParams());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.lookup.found).toBe(true);
    expect(json.lookup.record.name).toBe(RAW_NAME);
  });

  it("ハイフン混じりを正規化して lookup", async () => {
    await POST(makeRequest({ corporateNumber: "1234-5678-9012-3" }), makeParams());
    expect(vi.mocked(lookupCorporateNumber)).toHaveBeenCalledWith(RAW_NUMBER);
  });

  it("全角数字を正規化して lookup", async () => {
    await POST(
      makeRequest({ corporateNumber: "１２３４５６７８９０１２３" }),
      makeParams(),
    );
    expect(vi.mocked(lookupCorporateNumber)).toHaveBeenCalledWith(RAW_NUMBER);
  });

  it("空白混じりを正規化して lookup", async () => {
    await POST(
      makeRequest({ corporateNumber: " 1234 5678 9012 3 " }),
      makeParams(),
    );
    expect(vi.mocked(lookupCorporateNumber)).toHaveBeenCalledWith(RAW_NUMBER);
  });

  it("found=false (0件) を 200 で返す", async () => {
    vi.mocked(lookupCorporateNumber).mockResolvedValueOnce({
      found: false,
      isClosed: false,
      closeDate: null,
      closeCause: null,
      record: null,
      fetchedAt: "2026-05-22T07:30:00.000Z",
      source: "nta-houjin-bangou-v4",
    });
    const res = await POST(
      makeRequest({ corporateNumber: "9999999999999" }),
      makeParams(),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.lookup.found).toBe(false);
    expect(json.lookup.record).toBeNull();
  });

  it("廃止法人を 200 isClosed=true で返す", async () => {
    vi.mocked(lookupCorporateNumber).mockResolvedValueOnce({
      found: true,
      isClosed: true,
      closeDate: "2024-12-31",
      closeCause: "01",
      record: {
        corporateNumber: RAW_NUMBER,
        name: "廃止モック株式会社",
        furigana: null,
        address: "東京都港区六本木1-1-1",
        prefectureName: "東京都",
        cityName: "港区",
        streetNumber: "六本木1-1-1",
        postCode: null,
        updateDate: "2024-12-31",
      },
      fetchedAt: "2026-05-22T07:30:00.000Z",
      source: "nta-houjin-bangou-v4",
    });
    const res = await POST(makeRequest({ corporateNumber: RAW_NUMBER }), makeParams());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.lookup.isClosed).toBe(true);
    expect(json.lookup.closeDate).toBe("2024-12-31");
  });

  it("DB 更新が発生しない（owner.update が呼ばれない）", async () => {
    await POST(makeRequest({ corporateNumber: RAW_NUMBER }), makeParams());
    expect(pm.owner.update).not.toHaveBeenCalled();
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
    expect(pm.owner.create).not.toHaveBeenCalled();
  });

  it("AuditLog detail に法人番号生値・会社名・所在地・raw XML が含まれない", async () => {
    await POST(makeRequest({ corporateNumber: RAW_NUMBER }), makeParams());
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalled();
    const call = vi.mocked(writeAuditLog).mock.calls.at(-1)?.[0] as {
      action: string;
      detail: Record<string, unknown>;
    };
    expect(call.action).toBe("owner_corporate_lookup");
    const detailJson = JSON.stringify(call.detail);
    expect(detailJson).not.toContain(RAW_NUMBER);
    expect(detailJson).not.toContain(RAW_NAME);
    expect(detailJson).not.toContain(RAW_ADDRESS);
    expect(detailJson).not.toContain("○○カブシキガイシャ");
    expect(detailJson).not.toContain("1000005");
    expect(detailJson).not.toContain("<corporation>");
    expect(detailJson).not.toContain("<corporations>");
    // detail に入って良いのはフラグ・ソースのみ
    expect(call.detail.found).toBe(true);
    expect(call.detail.isClosed).toBe(false);
    expect(call.detail.source).toBe("nta-houjin-bangou-v4");
  });
});

describe("POST /api/owners/[id]/corporate-lookup — 異常系", () => {
  it("12桁は 422", async () => {
    const res = await POST(makeRequest({ corporateNumber: "123456789012" }), makeParams());
    expect(res.status).toBe(422);
    expect(vi.mocked(lookupCorporateNumber)).not.toHaveBeenCalled();
  });

  it("14桁は 422", async () => {
    const res = await POST(
      makeRequest({ corporateNumber: "12345678901234" }),
      makeParams(),
    );
    expect(res.status).toBe(422);
  });

  it("非文字列は 422", async () => {
    const res = await POST(makeRequest({ corporateNumber: 1234567890123 }), makeParams());
    expect(res.status).toBe(422);
  });

  it("owner:read 無しで 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValueOnce(PERMS_NO_OWNER_READ);
    const res = await POST(makeRequest({ corporateNumber: RAW_NUMBER }), makeParams());
    expect(res.status).toBe(403);
    expect(vi.mocked(lookupCorporateNumber)).not.toHaveBeenCalled();
  });

  it("owner_corporate_number 権限なしで 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValueOnce(PERMS_NO_CORP_WRITE);
    const res = await POST(makeRequest({ corporateNumber: RAW_NUMBER }), makeParams());
    expect(res.status).toBe(403);
  });

  it("owner not found で 404", async () => {
    pm.owner.findUnique.mockResolvedValueOnce(null);
    const res = await POST(makeRequest({ corporateNumber: RAW_NUMBER }), makeParams());
    expect(res.status).toBe(404);
  });

  it("archived owner で 404", async () => {
    pm.owner.findUnique.mockResolvedValueOnce({ id: OWNER_ID, isArchived: true });
    const res = await POST(makeRequest({ corporateNumber: RAW_NUMBER }), makeParams());
    expect(res.status).toBe(404);
  });

  it("env 未設定 (NOT_CONFIGURED) で 503", async () => {
    vi.mocked(lookupCorporateNumber).mockRejectedValueOnce(
      new CorporateLookupError("NOT_CONFIGURED", "未設定"),
    );
    const res = await POST(makeRequest({ corporateNumber: RAW_NUMBER }), makeParams());
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error.code).toBe("NOT_CONFIGURED");
  });

  it("上流 5xx (UPSTREAM_5XX) で 502", async () => {
    vi.mocked(lookupCorporateNumber).mockRejectedValueOnce(
      new CorporateLookupError("UPSTREAM_5XX", "5xx", 502),
    );
    const res = await POST(makeRequest({ corporateNumber: RAW_NUMBER }), makeParams());
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error.code).toBe("UPSTREAM_ERROR");
  });

  it("timeout (TIMEOUT) で 502", async () => {
    vi.mocked(lookupCorporateNumber).mockRejectedValueOnce(
      new CorporateLookupError("TIMEOUT", "timeout"),
    );
    const res = await POST(makeRequest({ corporateNumber: RAW_NUMBER }), makeParams());
    expect(res.status).toBe(502);
  });

  it("parse 失敗 (PARSE_ERROR) で 502", async () => {
    vi.mocked(lookupCorporateNumber).mockRejectedValueOnce(
      new CorporateLookupError("PARSE_ERROR", "parse"),
    );
    const res = await POST(makeRequest({ corporateNumber: RAW_NUMBER }), makeParams());
    expect(res.status).toBe(502);
  });

  it("RATE_LIMITED で 429", async () => {
    vi.mocked(lookupCorporateNumber).mockRejectedValueOnce(
      new CorporateLookupError("RATE_LIMITED", "429", 429),
    );
    const res = await POST(makeRequest({ corporateNumber: RAW_NUMBER }), makeParams());
    expect(res.status).toBe(429);
  });

  it("エラー時の AuditLog に法人番号生値が含まれない", async () => {
    vi.mocked(lookupCorporateNumber).mockRejectedValueOnce(
      new CorporateLookupError("UPSTREAM_5XX", "5xx", 502),
    );
    await POST(makeRequest({ corporateNumber: RAW_NUMBER }), makeParams());
    const calls = vi.mocked(writeAuditLog).mock.calls;
    if (calls.length > 0) {
      const detail = JSON.stringify(calls.at(-1)?.[0]?.detail ?? {});
      expect(detail).not.toContain(RAW_NUMBER);
    }
  });
});
