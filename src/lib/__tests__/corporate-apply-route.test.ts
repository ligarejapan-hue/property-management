/**
 * POST /api/owners/[id]/corporate-apply ルートテスト（Phase C）。
 *
 * 検証観点:
 * - 認証/認可 (owner:write / field-level)
 * - 13桁正規化と expectedRecord 一致
 * - apply 全 false で 400
 * - lookup not found / record.name 空で 422
 * - 廃止法人は allowClosed なしで 409、ありで反映可
 * - expectedRecord 不一致で 409 FETCH_STALE
 * - Owner.version 不一致で 409 CONFLICT
 * - 上流エラー (5xx/timeout/429/未設定)
 * - 正常系: Owner.version +1, ChangeLog 記録, AuditLog detail に PII が入らない
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
vi.mock("@/lib/change-log", async () => {
  const actual = await vi.importActual<typeof import("@/lib/change-log")>(
    "@/lib/change-log",
  );
  return {
    ...actual,
    recordChanges: vi.fn(),
  };
});

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
import { recordChanges } from "@/lib/change-log";
import {
  lookupCorporateNumber,
  CorporateLookupError,
} from "@/lib/corporate-lookup";
import { POST } from "../../app/api/owners/[id]/corporate-apply/route";

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
const RAW_FURIGANA = "○○カブシキガイシャ";
const RAW_POSTCODE = "1000005";
const RAW_UPDATE = "2025-04-01";

const PERMS_FULL = [
  { resource: "owner", action: "read", granted: true },
  { resource: "owner", action: "write", granted: true },
  { resource: "owner_name", action: "full", granted: true },
  { resource: "owner_address", action: "full", granted: true },
  { resource: "owner_zip", action: "full", granted: true },
  { resource: "owner_corporate_number", action: "full", granted: true },
];

function makeRequest(body: unknown) {
  return new Request(`http://localhost/api/owners/${OWNER_ID}/corporate-apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}
const makeParams = () => ({ params: Promise.resolve({ id: OWNER_ID }) });

function freshLookupOk(overrides: Partial<{
  found: boolean;
  isClosed: boolean;
  name: string;
  address: string;
  postCode: string | null;
  updateDate: string | null;
}> = {}) {
  return {
    found: overrides.found ?? true,
    isClosed: overrides.isClosed ?? false,
    closeDate: null,
    closeCause: null,
    record: {
      corporateNumber: RAW_NUMBER,
      name: overrides.name ?? RAW_NAME,
      furigana: RAW_FURIGANA,
      address: overrides.address ?? RAW_ADDRESS,
      prefectureName: "東京都",
      cityName: "千代田区",
      streetNumber: "丸の内１−１−１",
      postCode: overrides.postCode === undefined ? RAW_POSTCODE : overrides.postCode,
      updateDate: overrides.updateDate === undefined ? RAW_UPDATE : overrides.updateDate,
    },
    fetchedAt: "2026-05-23T07:30:00.000Z",
    source: "nta-houjin-bangou-v4",
  };
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    corporateNumber: RAW_NUMBER,
    version: 1,
    apply: { name: true, address: true, zip: true, corporateNumber: true },
    expectedRecord: {
      corporateNumber: RAW_NUMBER,
      name: RAW_NAME,
      address: RAW_ADDRESS,
      postCode: RAW_POSTCODE,
      updateDate: RAW_UPDATE,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL);
  pm.owner.findUnique.mockResolvedValue({
    id: OWNER_ID,
    isArchived: false,
    version: 1,
    name: "旧名称",
    address: "旧住所",
    zip: "999-9999",
    corporateNumber: null,
  });
  pm.owner.updateMany.mockResolvedValue({ count: 1 });
  vi.mocked(lookupCorporateNumber).mockResolvedValue(freshLookupOk());
});

describe("POST /api/owners/[id]/corporate-apply — 認可", () => {
  it("owner:write 無しで 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValueOnce([
      { resource: "owner", action: "read", granted: true },
      { resource: "owner_name", action: "full", granted: true },
      { resource: "owner_address", action: "full", granted: true },
      { resource: "owner_zip", action: "full", granted: true },
      { resource: "owner_corporate_number", action: "full", granted: true },
    ]);
    const res = await POST(makeRequest(payload()), makeParams());
    expect(res.status).toBe(403);
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
    expect(vi.mocked(lookupCorporateNumber)).not.toHaveBeenCalled();
  });

  it("owner_name 権限なしで apply.name=true は 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValueOnce([
      { resource: "owner", action: "read", granted: true },
      { resource: "owner", action: "write", granted: true },
      { resource: "owner_address", action: "full", granted: true },
      { resource: "owner_zip", action: "full", granted: true },
      { resource: "owner_corporate_number", action: "full", granted: true },
    ]);
    const res = await POST(makeRequest(payload()), makeParams());
    expect(res.status).toBe(403);
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });

  it("owner_address 権限なしで apply.address=true は 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValueOnce([
      { resource: "owner", action: "read", granted: true },
      { resource: "owner", action: "write", granted: true },
      { resource: "owner_name", action: "full", granted: true },
      { resource: "owner_zip", action: "full", granted: true },
      { resource: "owner_corporate_number", action: "full", granted: true },
    ]);
    const res = await POST(makeRequest(payload()), makeParams());
    expect(res.status).toBe(403);
  });

  it("owner_zip 権限なしで apply.zip=true は 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValueOnce([
      { resource: "owner", action: "read", granted: true },
      { resource: "owner", action: "write", granted: true },
      { resource: "owner_name", action: "full", granted: true },
      { resource: "owner_address", action: "full", granted: true },
      { resource: "owner_corporate_number", action: "full", granted: true },
    ]);
    const res = await POST(makeRequest(payload()), makeParams());
    expect(res.status).toBe(403);
  });

  it("owner_corporate_number 権限なしで apply.corporateNumber=true は 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValueOnce([
      { resource: "owner", action: "read", granted: true },
      { resource: "owner", action: "write", granted: true },
      { resource: "owner_name", action: "full", granted: true },
      { resource: "owner_address", action: "full", granted: true },
      { resource: "owner_zip", action: "full", granted: true },
    ]);
    const res = await POST(makeRequest(payload()), makeParams());
    expect(res.status).toBe(403);
  });

  it("field 権限不足でも apply=false ならその field はスキップ可", async () => {
    // owner_zip 権限なし、apply.zip=false → 通る
    vi.mocked(getUserPermissions).mockResolvedValueOnce([
      { resource: "owner", action: "read", granted: true },
      { resource: "owner", action: "write", granted: true },
      { resource: "owner_name", action: "full", granted: true },
      { resource: "owner_address", action: "full", granted: true },
      { resource: "owner_corporate_number", action: "full", granted: true },
    ]);
    const res = await POST(
      makeRequest(
        payload({
          apply: { name: true, address: true, zip: false, corporateNumber: true },
        }),
      ),
      makeParams(),
    );
    expect(res.status).toBe(200);
  });
});

describe("POST /api/owners/[id]/corporate-apply — バリデーション", () => {
  it("apply 全 false で 400", async () => {
    const res = await POST(
      makeRequest(
        payload({
          apply: { name: false, address: false, zip: false, corporateNumber: false },
        }),
      ),
      makeParams(),
    );
    expect(res.status).toBe(400);
    expect(vi.mocked(lookupCorporateNumber)).not.toHaveBeenCalled();
  });

  it("不正な body 形式で 400", async () => {
    const res = await POST(
      makeRequest({ corporateNumber: RAW_NUMBER }),
      makeParams(),
    );
    expect(res.status).toBe(400);
  });

  it("12桁は 422", async () => {
    const res = await POST(
      makeRequest(payload({ corporateNumber: "123456789012" })),
      makeParams(),
    );
    expect(res.status).toBe(422);
  });

  it("ハイフン混じり 13桁は正規化して通る", async () => {
    const res = await POST(
      makeRequest(payload({ corporateNumber: "1234-5678-9012-3" })),
      makeParams(),
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(lookupCorporateNumber)).toHaveBeenCalledWith(RAW_NUMBER);
  });

  it("body.corporateNumber と expectedRecord.corporateNumber が不一致で 409", async () => {
    const res = await POST(
      makeRequest(
        payload({
          expectedRecord: {
            corporateNumber: "9999999999999",
            name: RAW_NAME,
            address: RAW_ADDRESS,
            postCode: RAW_POSTCODE,
            updateDate: RAW_UPDATE,
          },
        }),
      ),
      makeParams(),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe("FETCH_STALE");
  });
});

describe("POST /api/owners/[id]/corporate-apply — owner / lookup 状態", () => {
  it("owner not found で 404", async () => {
    pm.owner.findUnique.mockResolvedValueOnce(null);
    const res = await POST(makeRequest(payload()), makeParams());
    expect(res.status).toBe(404);
  });

  it("archived owner で 404", async () => {
    pm.owner.findUnique.mockResolvedValueOnce({
      id: OWNER_ID,
      isArchived: true,
      version: 1,
    });
    const res = await POST(makeRequest(payload()), makeParams());
    expect(res.status).toBe(404);
  });

  it("lookup found=false で 422", async () => {
    vi.mocked(lookupCorporateNumber).mockResolvedValueOnce({
      found: false,
      isClosed: false,
      closeDate: null,
      closeCause: null,
      record: null,
      fetchedAt: "2026-05-23T07:30:00.000Z",
      source: "nta-houjin-bangou-v4",
    });
    const res = await POST(makeRequest(payload()), makeParams());
    expect(res.status).toBe(422);
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });

  it("lookup record.name 空で 422", async () => {
    vi.mocked(lookupCorporateNumber).mockResolvedValueOnce(
      freshLookupOk({ name: "" }),
    );
    const res = await POST(
      makeRequest(
        payload({
          expectedRecord: {
            corporateNumber: RAW_NUMBER,
            name: "",
            address: RAW_ADDRESS,
            postCode: RAW_POSTCODE,
            updateDate: RAW_UPDATE,
          },
        }),
      ),
      makeParams(),
    );
    expect(res.status).toBe(422);
  });

  it("廃止法人 + allowClosed=false で 409 CLOSED_NOT_ALLOWED", async () => {
    vi.mocked(lookupCorporateNumber).mockResolvedValueOnce(
      freshLookupOk({ isClosed: true }),
    );
    const res = await POST(makeRequest(payload()), makeParams());
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe("CLOSED_NOT_ALLOWED");
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });

  it("廃止法人 + allowClosed=true で反映可（200）", async () => {
    vi.mocked(lookupCorporateNumber).mockResolvedValueOnce(
      freshLookupOk({ isClosed: true }),
    );
    const res = await POST(
      makeRequest(payload({ allowClosed: true })),
      makeParams(),
    );
    expect(res.status).toBe(200);
    expect(pm.owner.updateMany).toHaveBeenCalledOnce();
  });

  it("expectedRecord.name と再 lookup の name が不一致で 409 FETCH_STALE", async () => {
    vi.mocked(lookupCorporateNumber).mockResolvedValueOnce(
      freshLookupOk({ name: "新しい社名株式会社" }),
    );
    const res = await POST(makeRequest(payload()), makeParams());
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe("FETCH_STALE");
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });

  it("expectedRecord.address と再 lookup の address が不一致で 409 FETCH_STALE", async () => {
    vi.mocked(lookupCorporateNumber).mockResolvedValueOnce(
      freshLookupOk({ address: "東京都港区六本木1-1-1" }),
    );
    const res = await POST(makeRequest(payload()), makeParams());
    expect(res.status).toBe(409);
  });

  it("zip 反映時に postCode が 7桁でなければ 422", async () => {
    vi.mocked(lookupCorporateNumber).mockResolvedValueOnce(
      freshLookupOk({ postCode: "12345" }),
    );
    const res = await POST(
      makeRequest(
        payload({
          expectedRecord: {
            corporateNumber: RAW_NUMBER,
            name: RAW_NAME,
            address: RAW_ADDRESS,
            postCode: "12345",
            updateDate: RAW_UPDATE,
          },
        }),
      ),
      makeParams(),
    );
    expect(res.status).toBe(422);
  });

  it("zip を反映しない場合は postCode が無くても 200", async () => {
    vi.mocked(lookupCorporateNumber).mockResolvedValueOnce(
      freshLookupOk({ postCode: null }),
    );
    const res = await POST(
      makeRequest(
        payload({
          apply: { name: true, address: true, zip: false, corporateNumber: true },
          expectedRecord: {
            corporateNumber: RAW_NUMBER,
            name: RAW_NAME,
            address: RAW_ADDRESS,
            postCode: null,
            updateDate: RAW_UPDATE,
          },
        }),
      ),
      makeParams(),
    );
    expect(res.status).toBe(200);
  });
});

describe("POST /api/owners/[id]/corporate-apply — optimistic lock", () => {
  it("version 不一致で 409 CONFLICT", async () => {
    pm.owner.updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await POST(makeRequest(payload()), makeParams());
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe("CONFLICT");
  });
});

describe("POST /api/owners/[id]/corporate-apply — 上流エラー", () => {
  it("env 未設定で 503", async () => {
    vi.mocked(lookupCorporateNumber).mockRejectedValueOnce(
      new CorporateLookupError("NOT_CONFIGURED", "未設定"),
    );
    const res = await POST(makeRequest(payload()), makeParams());
    expect(res.status).toBe(503);
  });

  it("上流 5xx で 502", async () => {
    vi.mocked(lookupCorporateNumber).mockRejectedValueOnce(
      new CorporateLookupError("UPSTREAM_5XX", "5xx", 502),
    );
    const res = await POST(makeRequest(payload()), makeParams());
    expect(res.status).toBe(502);
  });

  it("timeout で 502", async () => {
    vi.mocked(lookupCorporateNumber).mockRejectedValueOnce(
      new CorporateLookupError("TIMEOUT", "timeout"),
    );
    const res = await POST(makeRequest(payload()), makeParams());
    expect(res.status).toBe(502);
  });

  it("429 で 429", async () => {
    vi.mocked(lookupCorporateNumber).mockRejectedValueOnce(
      new CorporateLookupError("RATE_LIMITED", "429", 429),
    );
    const res = await POST(makeRequest(payload()), makeParams());
    expect(res.status).toBe(429);
  });
});

describe("POST /api/owners/[id]/corporate-apply — 正常系", () => {
  it("Owner.version +1, updateMany が version で絞り込み + increment 指定", async () => {
    const res = await POST(makeRequest(payload({ version: 5 })), makeParams());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.owner.id).toBe(OWNER_ID);
    expect(pm.owner.updateMany).toHaveBeenCalledOnce();
    const updateArg = pm.owner.updateMany.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: OWNER_ID, version: 5 });
    expect(updateArg.data.version).toEqual({ increment: 1 });
  });

  it("zip は 7桁 postCode → XXX-XXXX 形式に整形される", async () => {
    await POST(makeRequest(payload()), makeParams());
    const updateArg = pm.owner.updateMany.mock.calls[0][0];
    expect(updateArg.data.zip).toBe("100-0005");
  });

  it("ChangeLog が name/address/zip/corporateNumber について呼ばれる", async () => {
    await POST(makeRequest(payload()), makeParams());
    expect(vi.mocked(recordChanges)).toHaveBeenCalledOnce();
    const arg = vi.mocked(recordChanges).mock.calls[0][0];
    expect(arg.targetTable).toBe("owners");
    expect(arg.targetId).toBe(OWNER_ID);
    expect(Object.keys(arg.newValues).sort()).toEqual(
      ["address", "corporateNumber", "name", "zip"].sort(),
    );
    expect(arg.trackedFields).toContain("name");
    expect(arg.trackedFields).toContain("address");
    expect(arg.trackedFields).toContain("zip");
    expect(arg.trackedFields).toContain("corporateNumber");
  });

  it("AuditLog detail に法人番号・会社名・住所・郵便番号・raw XML・Owner PII が含まれない", async () => {
    await POST(makeRequest(payload()), makeParams());
    const calls = vi.mocked(writeAuditLog).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const call = calls.at(-1)?.[0] as {
      action: string;
      detail: Record<string, unknown>;
    };
    expect(call.action).toBe("owner_corporate_apply");
    const detailJson = JSON.stringify(call.detail);
    expect(detailJson).not.toContain(RAW_NUMBER);
    expect(detailJson).not.toContain(RAW_NAME);
    expect(detailJson).not.toContain(RAW_ADDRESS);
    expect(detailJson).not.toContain(RAW_FURIGANA);
    expect(detailJson).not.toContain(RAW_POSTCODE);
    expect(detailJson).not.toContain("100-0005");
    expect(detailJson).not.toContain("旧名称");
    expect(detailJson).not.toContain("旧住所");
    expect(detailJson).not.toContain("<corporation>");
    expect(detailJson).not.toContain("<corporations>");
    expect(call.detail.result).toBe("applied");
    expect(call.detail.isClosed).toBe(false);
    expect(call.detail.source).toBe("nta-houjin-bangou-v4");
    expect(call.detail.applied).toEqual({
      name: true,
      address: true,
      zip: true,
      corporateNumber: true,
    });
  });

  it("エラー時の AuditLog にも生値が含まれない", async () => {
    vi.mocked(lookupCorporateNumber).mockRejectedValueOnce(
      new CorporateLookupError("UPSTREAM_5XX", "5xx", 502),
    );
    await POST(makeRequest(payload()), makeParams());
    const calls = vi.mocked(writeAuditLog).mock.calls;
    if (calls.length > 0) {
      const detail = JSON.stringify(calls.at(-1)?.[0]?.detail ?? {});
      expect(detail).not.toContain(RAW_NUMBER);
      expect(detail).not.toContain(RAW_NAME);
      expect(detail).not.toContain(RAW_ADDRESS);
    }
  });

  it("apply.name=true のみで他フィールドは触らない", async () => {
    const res = await POST(
      makeRequest(
        payload({
          apply: { name: true, address: false, zip: false, corporateNumber: false },
        }),
      ),
      makeParams(),
    );
    expect(res.status).toBe(200);
    const updateArg = pm.owner.updateMany.mock.calls[0][0];
    expect(Object.keys(updateArg.data).sort()).toEqual(["name", "version"]);
    expect(updateArg.data.name).toBe(RAW_NAME);
  });
});
