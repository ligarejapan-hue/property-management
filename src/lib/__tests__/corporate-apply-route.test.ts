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
    // Task 6(編集の鍵): 反映の updateMany は $transaction(所有者行ロック→鍵の確認→更新)
    // に包まれる。既存の owner.updateMany 検証をそのまま使えるよう、$transaction は
    // コールバックへ同じ prisma モックを渡すだけにする。
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
  },
}));

// Task 6(編集の鍵): 反映は $transaction(所有者行ロック→鍵の確認→更新)に包まれる。
// 既定は no-op(未設定=undefined 解決)にして、既存テスト(ヘッダ無し・鍵無し)は
// そのまま通す。鍵まわりの検証は専用の describe でこのモックを差し替える。
vi.mock("@/lib/edit-lock/service", () => ({ assertNotEditLockedByOther: vi.fn() }));

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
import { ApiError, getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { recordChanges } from "@/lib/change-log";
import {
  lookupCorporateNumber,
  CorporateLookupError,
} from "@/lib/corporate-lookup";
import { assertNotEditLockedByOther } from "@/lib/edit-lock/service";
import { POST } from "../../app/api/owners/[id]/corporate-apply/route";

const pm = prisma as unknown as {
  owner: {
    findUnique: Mock;
    update: Mock;
    updateMany: Mock;
    create: Mock;
  };
  $transaction: Mock;
  $queryRaw: Mock;
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
  pm.$transaction.mockImplementation((fn: (tx: typeof pm) => unknown) => fn(pm));
  pm.$queryRaw.mockResolvedValue([]);
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL);
  // 既定: name/address raw-visible(full)。owner 名/住所は record と一致 → conflict="match"
  // （conflict ゲートは既定でブロックしない。conflict は専用テストで検証する）。
  vi.mocked(getOwnerDisplayConfig).mockResolvedValue({
    name: "full",
    address: "full",
  } as unknown as Awaited<ReturnType<typeof getOwnerDisplayConfig>>);
  pm.owner.findUnique.mockResolvedValue({
    id: OWNER_ID,
    isArchived: false,
    version: 1,
    name: RAW_NAME,
    address: RAW_ADDRESS,
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
    // owner_corporate_number 権限なし、apply.corporateNumber=false → 通る。
    // ⚠住所/郵便番号は一組でしか選べないので、この確認には法人番号を使う。
    vi.mocked(getUserPermissions).mockResolvedValueOnce([
      { resource: "owner", action: "read", granted: true },
      { resource: "owner", action: "write", granted: true },
      { resource: "owner_name", action: "full", granted: true },
      { resource: "owner_address", action: "full", granted: true },
      { resource: "owner_zip", action: "full", granted: true },
    ]);
    const res = await POST(
      makeRequest(
        payload({
          apply: { name: true, address: true, zip: true, corporateNumber: false },
        }),
      ),
      makeParams(),
    );
    expect(res.status).toBe(200);
  });

  it("⚠住所だけの反映はできない（国税庁の住所 + 古い郵便番号を作らない）", async () => {
    const res = await POST(
      makeRequest(
        payload({
          apply: { name: false, address: true, zip: false, corporateNumber: false },
        }),
      ),
      makeParams(),
    );
    expect(res.status).toBe(400);
  });

  it("⚠郵便番号だけの反映もできない（国税庁の番号 + 元の住所を作らない）", async () => {
    const res = await POST(
      makeRequest(
        payload({
          apply: { name: false, address: false, zip: true, corporateNumber: false },
        }),
      ),
      makeParams(),
    );
    expect(res.status).toBe(400);
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

  it("⚠郵便番号が7桁でなければ空にする（住所は反映する）", async () => {
    // 読めない番号を宛先に刷らない。番号だけ空にして住所は入れる。
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
    expect(res.status).toBe(200);
    expect(pm.owner.updateMany.mock.calls[0][0].data.zip).toBeNull();
  });

  it("⚠国税庁に郵便番号が無いときは、住所を反映して郵便番号は空にする", async () => {
    // 拒否すると住所も反映できなくなり、古い番号を残すと
    // 「国税庁の住所 + 前の場所の番号」というズレた宛先になる。
    vi.mocked(lookupCorporateNumber).mockResolvedValueOnce(
      freshLookupOk({ postCode: null }),
    );
    const res = await POST(
      makeRequest(
        payload({
          apply: { name: true, address: true, zip: true, corporateNumber: true },
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
    expect(pm.owner.updateMany.mock.calls[0][0].data.zip).toBeNull();
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

describe("POST /api/owners/[id]/corporate-apply — conflict ゲート", () => {
  const MISMATCH_OWNER = {
    id: OWNER_ID,
    isArchived: false,
    version: 1,
    name: "まったく別の株式会社",
    address: "大阪府大阪市北区梅田2-2-2",
    zip: "999-9999",
    corporateNumber: null,
  };

  it("明らかな不一致 + acknowledgeConflict 無で 409 CONFLICT_NOT_ACKNOWLEDGED", async () => {
    pm.owner.findUnique.mockResolvedValueOnce(MISMATCH_OWNER);
    const res = await POST(makeRequest(payload()), makeParams());
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe("CONFLICT_NOT_ACKNOWLEDGED");
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });

  it("明らかな不一致でも acknowledgeConflict=true なら反映可(200)", async () => {
    pm.owner.findUnique.mockResolvedValueOnce(MISMATCH_OWNER);
    const res = await POST(
      makeRequest(payload({ acknowledgeConflict: true })),
      makeParams(),
    );
    expect(res.status).toBe(200);
    expect(pm.owner.updateMany).toHaveBeenCalledOnce();
  });

  it("name/address が field 不可視(hidden)なら conflict 判定せず通る(unknown)", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValueOnce({
      name: "hidden",
      address: "hidden",
    } as unknown as Awaited<ReturnType<typeof getOwnerDisplayConfig>>);
    pm.owner.findUnique.mockResolvedValueOnce(MISMATCH_OWNER);
    const res = await POST(makeRequest(payload()), makeParams());
    expect(res.status).toBe(200);
  });

  it("conflict ゲートは廃止/stale チェックの後段(closed が先に 409 CLOSED_NOT_ALLOWED)", async () => {
    pm.owner.findUnique.mockResolvedValueOnce(MISMATCH_OWNER);
    vi.mocked(lookupCorporateNumber).mockResolvedValueOnce(
      freshLookupOk({ isClosed: true }),
    );
    const res = await POST(makeRequest(payload()), makeParams());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("CLOSED_NOT_ALLOWED");
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

describe("POST /api/owners/[id]/corporate-apply — companyRegistryNumber(12桁) 案2", () => {
  it("apply.corporateNumber=true + companyRegistryNumber(12桁) を別カラムへ正規化保存", async () => {
    await POST(
      makeRequest(payload({ companyRegistryNumber: "1234-5678-9012" })),
      makeParams(),
    );
    const updateArg = pm.owner.updateMany.mock.calls[0][0];
    expect(updateArg.data.corporateNumber).toBe(RAW_NUMBER);
    expect(updateArg.data.companyRegistryNumber).toBe("123456789012");
  });

  it("apply.corporateNumber=false なら companyRegistryNumber を保存しない", async () => {
    await POST(
      makeRequest(
        payload({
          apply: { name: true, address: false, zip: false, corporateNumber: false },
          companyRegistryNumber: "123456789012",
        }),
      ),
      makeParams(),
    );
    const updateArg = pm.owner.updateMany.mock.calls[0][0];
    expect(updateArg.data).not.toHaveProperty("companyRegistryNumber");
  });

  it("companyRegistryNumber が12桁でない(13桁)→ 422・書込しない", async () => {
    const res = await POST(
      makeRequest(payload({ companyRegistryNumber: "1234567890123" })),
      makeParams(),
    );
    expect(res.status).toBe(422);
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });

  it("companyRegistryNumber 未指定なら corporateNumber のみ保存（後方互換）", async () => {
    await POST(makeRequest(payload()), makeParams());
    const updateArg = pm.owner.updateMany.mock.calls[0][0];
    expect(updateArg.data.corporateNumber).toBe(RAW_NUMBER);
    expect(updateArg.data).not.toHaveProperty("companyRegistryNumber");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Task 6: 保存の窓口3本目 — 編集中の鍵
// ─────────────────────────────────────────────────────────────────────────

describe("POST /api/owners/[id]/corporate-apply — 編集中の鍵(Task 6)", () => {
  // ⚠「呼ばれたこと」だけを見るテストでは、トランザクションの外で呼んでも
  //   書き込みの後に呼んでも通ってしまう(@codex R6 P2)。**順序そのもの**を記録して検査する。
  // ⚠さらに、この describe 以外のテストがそうしているように $transaction が
  //   base client(pm)をそのまま tx として渡すと、「lock/assert/update が pm に
  //   対して呼ばれているだけ」でも同じ順序配列・200 になってしまう
  //   (review Important 1: 書き込みが tx の外へ逃げても検出できない)。
  //   ここだけは **base client とは別物の tx** を渡し、**tx そのものが渡ったこと**
  //   (identity)と **base client の $queryRaw/updateMany が呼ばれていないこと**まで
  //   固定する。行ロックの SQL 自体(FOR UPDATE + 所有者id)も検査する(review Minor 7)。
  it("トランザクション開始 → 所有者行ロック → 鍵の確認 → 条件つき更新 の順で呼ばれ、すべて同じ tx を使う(base client は使わない)", async () => {
    const order: string[] = [];
    let lockSql = "";
    let txClient: { $queryRaw: Mock; owner: { updateMany: Mock } } | undefined;
    pm.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      order.push("tx");
      txClient = {
        $queryRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
          order.push("lock");
          lockSql = strings.reduce((acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ""), "");
          return Promise.resolve([]);
        }),
        owner: {
          updateMany: vi.fn(async () => {
            order.push("update");
            return { count: 1 };
          }),
        },
      };
      return fn(txClient);
    });
    vi.mocked(assertNotEditLockedByOther).mockImplementation(async () => {
      order.push("assert");
    });

    const res = await POST(makeRequest(payload()), makeParams());

    expect(res.status).toBe(200);
    expect(order).toEqual(["tx", "lock", "assert", "update"]);
    expect(lockSql).toContain("FOR UPDATE");
    expect(lockSql).toContain(OWNER_ID);
    expect(vi.mocked(assertNotEditLockedByOther)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(assertNotEditLockedByOther).mock.calls[0][0]).toBe(txClient);
    // 行ロック・書き込みが base client(pm)に漏れていない
    // (=トランザクションの外へ逃げていない)ことを固定する。
    expect(pm.$queryRaw).not.toHaveBeenCalled();
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });

  it("鍵が他人のものなら 423 を返し、反映は行われない", async () => {
    vi.mocked(assertNotEditLockedByOther).mockRejectedValueOnce(
      new ApiError(423, "他の画面で編集中です", "EDIT_LOCKED"),
    );
    const res = await POST(makeRequest(payload()), makeParams());
    expect(res.status).toBe(423);
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });

  it("合言葉のヘッダが無くても呼ばれる(古い画面。鍵が無ければ通る)", async () => {
    const res = await POST(makeRequest(payload()), makeParams());
    expect(res.status).toBe(200);
    expect(vi.mocked(assertNotEditLockedByOther)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ screenTokenHash: null, lockId: null }),
    );
  });

  it("X-Edit-Lock が uuid でなければ 400 を返し、鍵の確認自体が走らない", async () => {
    const req = new Request(
      `http://localhost/api/owners/${OWNER_ID}/corporate-apply`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Edit-Lock": "not-a-uuid" },
        body: JSON.stringify(payload()),
      },
    ) as unknown as import("next/server").NextRequest;
    const res = await POST(req, makeParams());
    expect(res.status).toBe(400);
    expect(vi.mocked(assertNotEditLockedByOther)).not.toHaveBeenCalled();
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });

  it("X-Edit-Lock が uuid なら世代として渡す", async () => {
    const lockId = "33333333-3333-4333-8333-333333333333";
    const req = new Request(
      `http://localhost/api/owners/${OWNER_ID}/corporate-apply`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Edit-Lock": lockId },
        body: JSON.stringify(payload()),
      },
    ) as unknown as import("next/server").NextRequest;
    await POST(req, makeParams());
    expect(vi.mocked(assertNotEditLockedByOther)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ lockId }),
    );
  });
});
