/**
 * POST /api/admin/owners/correction/merge-preview route tests.
 *
 * - dryRun preview のみ。DB 更新なし。
 * - 権限: user_management:read + owner:read
 * - レスポンス・AuditLog detail に PII を含めない（enum / 件数 / ID のみ）。
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
    owner: { findUnique: vi.fn() },
    changeLog: { count: vi.fn() },
    importJobRow: { findMany: vi.fn() },
    ownerMemo: { count: vi.fn() },
    propertyOwner: { findMany: vi.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { getUserPermissions } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { POST } from "../../app/api/admin/owners/correction/merge-preview/route";

const MASTER_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_ID = "22222222-2222-4222-8222-222222222222";
const MASTER_NAME = "田中太郎";
const MASTER_ADDRESS = "東京都港区1-1";
const SOURCE_NAME = "田中 太郎"; // 全角空白を含む別表記
const SOURCE_ADDRESS = "東京都港区1-1";

const pm = prisma as unknown as {
  owner: { findUnique: Mock };
  changeLog: { count: Mock };
  importJobRow: { findMany: Mock };
  ownerMemo: { count: Mock };
  propertyOwner: { findMany: Mock };
};

const FULL_PERMS = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
];

function makeRequest(body: unknown) {
  return new Request(
    "http://localhost/api/admin/owners/correction/merge-preview",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  ) as unknown as import("next/server").NextRequest;
}

function makeOwner(overrides: Partial<{
  id: string;
  name: string;
  address: string | null;
  zip: string | null;
  phone: string | null;
  version: number;
  isArchived: boolean;
  note: string | null;
  externalLinkKey: string | null;
}> = {}) {
  return {
    id: overrides.id ?? SOURCE_ID,
    name: overrides.name ?? SOURCE_NAME,
    address: overrides.address !== undefined ? overrides.address : SOURCE_ADDRESS,
    zip: overrides.zip !== undefined ? overrides.zip : null,
    phone: overrides.phone !== undefined ? overrides.phone : null,
    version: overrides.version ?? 1,
    isArchived: overrides.isArchived ?? false,
    note: overrides.note ?? null,
    externalLinkKey: overrides.externalLinkKey ?? null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getUserPermissions).mockResolvedValue(FULL_PERMS);
  // デフォルト: master / source ともに存在、eligible 想定
  pm.owner.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
    if (where.id === MASTER_ID) {
      return Promise.resolve(
        makeOwner({ id: MASTER_ID, name: MASTER_NAME, address: MASTER_ADDRESS }),
      );
    }
    if (where.id === SOURCE_ID) {
      return Promise.resolve(
        makeOwner({ id: SOURCE_ID, name: SOURCE_NAME, address: SOURCE_ADDRESS }),
      );
    }
    return Promise.resolve(null);
  });
  pm.changeLog.count.mockResolvedValue(0);
  pm.importJobRow.findMany.mockResolvedValue([{ id: "row-1" }]);
  pm.ownerMemo.count.mockResolvedValue(0);
  pm.propertyOwner.findMany.mockResolvedValue([]);
});

describe("POST /api/admin/owners/correction/merge-preview", () => {
  it("全条件パス → eligible=true, summary が返る, AuditLog 記録", async () => {
    const res = await POST(
      makeRequest({ masterId: MASTER_ID, sourceId: SOURCE_ID }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.eligible).toBe(true);
    expect(json.blockReasons).toEqual([]);
    expect(json.masterId).toBe(MASTER_ID);
    expect(json.sourceId).toBe(SOURCE_ID);
    expect(json.summary).toMatchObject({
      propertyOwnersToMove: 0,
      propertyOwnersToDeduplicate: 0,
      sourceOwnerMemoCount: 0,
      sourceOwnerMemoWithPropertyCount: 0,
      sourceChangeLogCount: 0,
      sourceImportJobRowCount: 1,
      sourceVersion: 1,
      masterVersion: 1,
      normalizeKeyMatches: true,
    });
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "owner_correction_merge_preview",
        targetTable: "owners",
        targetId: MASTER_ID,
        detail: {
          masterId: MASTER_ID,
          sourceId: SOURCE_ID,
          eligible: true,
          blockReasons: [],
        },
      }),
    );
  });

  it("user_management:read なし → 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue([
      { resource: "owner", action: "read", granted: true },
    ]);
    const res = await POST(
      makeRequest({ masterId: MASTER_ID, sourceId: SOURCE_ID }),
    );
    expect(res.status).toBe(403);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("owner:read なし → 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue([
      { resource: "user_management", action: "read", granted: true },
    ]);
    const res = await POST(
      makeRequest({ masterId: MASTER_ID, sourceId: SOURCE_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("masterId が UUID 形式でない → 400", async () => {
    const res = await POST(
      makeRequest({ masterId: "not-a-uuid", sourceId: SOURCE_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("sourceId が UUID 形式でない → 400", async () => {
    const res = await POST(
      makeRequest({ masterId: MASTER_ID, sourceId: "not-a-uuid" }),
    );
    expect(res.status).toBe(400);
  });

  it("same_owner_id → 422 + blockReasons", async () => {
    const res = await POST(
      makeRequest({ masterId: MASTER_ID, sourceId: MASTER_ID }),
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.code).toBe("MERGE_PREVIEW_BLOCKED");
    expect(json.error.blockReasons).toContain("same_owner_id");
    // AuditLog はこのケースでは書かなくて良い（先に 422 で抜けるため）
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("master / source 両方が存在しない → 404", async () => {
    pm.owner.findUnique.mockResolvedValue(null);
    const res = await POST(
      makeRequest({ masterId: MASTER_ID, sourceId: SOURCE_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("source のみ存在しない → 200 + blockReasons=[source_not_found]", async () => {
    pm.owner.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      if (where.id === MASTER_ID) {
        return Promise.resolve(
          makeOwner({ id: MASTER_ID, name: MASTER_NAME, address: MASTER_ADDRESS }),
        );
      }
      return Promise.resolve(null);
    });
    const res = await POST(
      makeRequest({ masterId: MASTER_ID, sourceId: SOURCE_ID }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.eligible).toBe(false);
    expect(json.blockReasons).toContain("source_not_found");
  });

  it("source が archived → 200 + blockReasons=[source_archived]", async () => {
    pm.owner.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      if (where.id === MASTER_ID) {
        return Promise.resolve(makeOwner({ id: MASTER_ID, name: MASTER_NAME, address: MASTER_ADDRESS }));
      }
      return Promise.resolve(
        makeOwner({
          id: SOURCE_ID,
          name: SOURCE_NAME,
          address: SOURCE_ADDRESS,
          isArchived: true,
        }),
      );
    });
    const res = await POST(
      makeRequest({ masterId: MASTER_ID, sourceId: SOURCE_ID }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.eligible).toBe(false);
    expect(json.blockReasons).toContain("source_archived");
  });

  it("source has ChangeLog → 200 + blockReasons=[source_has_changelog]", async () => {
    pm.changeLog.count.mockResolvedValue(3);
    const res = await POST(
      makeRequest({ masterId: MASTER_ID, sourceId: SOURCE_ID }),
    );
    const json = await res.json();
    expect(json.eligible).toBe(false);
    expect(json.blockReasons).toContain("source_has_changelog");
    expect(json.summary.sourceChangeLogCount).toBe(3);
  });

  it("正規化キー不一致 → blockReasons=[name_address_normalize_mismatch]", async () => {
    pm.owner.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      if (where.id === MASTER_ID) {
        return Promise.resolve(
          makeOwner({ id: MASTER_ID, name: "田中太郎", address: "東京都港区1-1" }),
        );
      }
      return Promise.resolve(
        makeOwner({ id: SOURCE_ID, name: "鈴木次郎", address: "大阪府大阪市2-2" }),
      );
    });
    const res = await POST(
      makeRequest({ masterId: MASTER_ID, sourceId: SOURCE_ID }),
    );
    const json = await res.json();
    expect(json.eligible).toBe(false);
    expect(json.blockReasons).toContain("name_address_normalize_mismatch");
    expect(json.summary.normalizeKeyMatches).toBe(false);
  });

  it("OwnerMemo 1件以上の source でも eligible=true（blocker でないこと）", async () => {
    pm.ownerMemo.count.mockImplementation(({ where }: { where: { propertyId?: unknown } }) => {
      // 1回目: 合計, 2回目: propertyId 付き（順序保証は実装に依存しないが、本テストでは
      // 値だけ確認すれば十分）。 propertyId 条件があるかどうかで分岐する。
      if (where.propertyId !== undefined) {
        return Promise.resolve(1);
      }
      return Promise.resolve(3);
    });

    const res = await POST(
      makeRequest({ masterId: MASTER_ID, sourceId: SOURCE_ID }),
    );
    const json = await res.json();
    expect(json.eligible).toBe(true);
    expect(json.blockReasons).toEqual([]);
    expect(json.summary.sourceOwnerMemoCount).toBe(3);
    expect(json.summary.sourceOwnerMemoWithPropertyCount).toBe(1);
  });

  it("PropertyOwner 移動と重複の件数を正しく集計", async () => {
    pm.propertyOwner.findMany.mockImplementation(
      ({ where }: { where: { ownerId: string } }) => {
        if (where.ownerId === MASTER_ID) {
          return Promise.resolve([
            { propertyId: "prop-A" },
            { propertyId: "prop-B" },
          ]);
        }
        if (where.ownerId === SOURCE_ID) {
          return Promise.resolve([
            { propertyId: "prop-B" }, // master と重複
            { propertyId: "prop-C" },
            { propertyId: "prop-D" },
          ]);
        }
        return Promise.resolve([]);
      },
    );

    const res = await POST(
      makeRequest({ masterId: MASTER_ID, sourceId: SOURCE_ID }),
    );
    const json = await res.json();
    expect(json.summary.propertyOwnersToMove).toBe(2); // C, D
    expect(json.summary.propertyOwnersToDeduplicate).toBe(1); // B
  });

  it("API レスポンスに PII（owner 名 / 住所）が含まれない", async () => {
    const res = await POST(
      makeRequest({ masterId: MASTER_ID, sourceId: SOURCE_ID }),
    );
    const text = await res.text();
    expect(text).not.toContain(MASTER_NAME);
    expect(text).not.toContain(SOURCE_NAME);
    expect(text).not.toContain(MASTER_ADDRESS);
    expect(text).not.toContain(SOURCE_ADDRESS);
  });

  it("AuditLog detail に PII（owner 名 / 住所）が含まれない", async () => {
    await POST(
      makeRequest({ masterId: MASTER_ID, sourceId: SOURCE_ID }),
    );
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    const call = vi.mocked(writeAuditLog).mock.calls[0][0];
    const serialized = JSON.stringify(call.detail);
    expect(serialized).not.toContain(MASTER_NAME);
    expect(serialized).not.toContain(SOURCE_NAME);
    expect(serialized).not.toContain(MASTER_ADDRESS);
    expect(serialized).not.toContain(SOURCE_ADDRESS);
    // detail には id / eligible / blockReasons のみ
    expect(call.detail).toMatchObject({
      masterId: MASTER_ID,
      sourceId: SOURCE_ID,
      eligible: true,
      blockReasons: [],
    });
  });

  it("addressなし fallback: 同じ zip + phone のペアは normalizeKeyMatches=true / eligible", async () => {
    pm.owner.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      if (where.id === MASTER_ID) {
        return Promise.resolve(
          makeOwner({
            id: MASTER_ID,
            name: "田中太郎",
            address: null,
            zip: "100-0001",
            phone: "090-1234-5678",
          }),
        );
      }
      return Promise.resolve(
        makeOwner({
          id: SOURCE_ID,
          name: "田中 太郎", // 全角空白を含む別表記
          address: null,
          zip: "100-0001",
          phone: "090-1234-5678",
        }),
      );
    });

    const res = await POST(
      makeRequest({ masterId: MASTER_ID, sourceId: SOURCE_ID }),
    );
    const json = await res.json();
    expect(json.summary.normalizeKeyMatches).toBe(true);
    expect(json.eligible).toBe(true);
    expect(json.blockReasons).not.toContain("name_address_normalize_mismatch");
  });

  it("addressなし fallback: zip が違うペアは normalizeKeyMatches=false / blockReason", async () => {
    pm.owner.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      if (where.id === MASTER_ID) {
        return Promise.resolve(
          makeOwner({
            id: MASTER_ID,
            name: "田中太郎",
            address: null,
            zip: "100-0001",
            phone: "090-1234-5678",
          }),
        );
      }
      return Promise.resolve(
        makeOwner({
          id: SOURCE_ID,
          name: "田中太郎",
          address: null,
          zip: "200-0002", // zip が違う → fallback key 不一致
          phone: "090-1234-5678",
        }),
      );
    });

    const res = await POST(
      makeRequest({ masterId: MASTER_ID, sourceId: SOURCE_ID }),
    );
    const json = await res.json();
    expect(json.summary.normalizeKeyMatches).toBe(false);
    expect(json.eligible).toBe(false);
    expect(json.blockReasons).toContain("name_address_normalize_mismatch");
  });

  it("addressなし fallback: name 不一致は normalizeKeyMatches=false / blockReason", async () => {
    pm.owner.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      if (where.id === MASTER_ID) {
        return Promise.resolve(
          makeOwner({
            id: MASTER_ID,
            name: "田中太郎",
            address: null,
            zip: "100-0001",
            phone: "090-1234-5678",
          }),
        );
      }
      return Promise.resolve(
        makeOwner({
          id: SOURCE_ID,
          name: "鈴木次郎", // name が違う
          address: null,
          zip: "100-0001",
          phone: "090-1234-5678",
        }),
      );
    });

    const res = await POST(
      makeRequest({ masterId: MASTER_ID, sourceId: SOURCE_ID }),
    );
    const json = await res.json();
    expect(json.summary.normalizeKeyMatches).toBe(false);
    expect(json.blockReasons).toContain("name_address_normalize_mismatch");
  });

  it("片方だけ address あり / 片方 null → normalizeKeyMatches=false", async () => {
    pm.owner.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      if (where.id === MASTER_ID) {
        return Promise.resolve(
          makeOwner({
            id: MASTER_ID,
            name: "田中太郎",
            address: "東京都港区1-1",
            zip: null,
            phone: null,
          }),
        );
      }
      return Promise.resolve(
        makeOwner({
          id: SOURCE_ID,
          name: "田中太郎",
          address: null, // address なし → fallback key になり、address あり master と不一致
          zip: null,
          phone: null,
        }),
      );
    });

    const res = await POST(
      makeRequest({ masterId: MASTER_ID, sourceId: SOURCE_ID }),
    );
    const json = await res.json();
    expect(json.summary.normalizeKeyMatches).toBe(false);
  });

  it("複数違反は全件返す", async () => {
    pm.owner.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      if (where.id === MASTER_ID) {
        return Promise.resolve(
          makeOwner({ id: MASTER_ID, name: MASTER_NAME, address: MASTER_ADDRESS }),
        );
      }
      return Promise.resolve(
        makeOwner({
          id: SOURCE_ID,
          name: SOURCE_NAME,
          address: SOURCE_ADDRESS,
          isArchived: true,
          note: "重要メモ",
          externalLinkKey: "EXT-001",
          version: 5,
        }),
      );
    });
    pm.changeLog.count.mockResolvedValue(2);

    const res = await POST(
      makeRequest({ masterId: MASTER_ID, sourceId: SOURCE_ID }),
    );
    const json = await res.json();
    expect(json.eligible).toBe(false);
    expect(json.blockReasons).toEqual(
      expect.arrayContaining([
        "source_archived",
        "source_has_changelog",
        "source_has_note",
        "source_has_external_link_key",
        "source_version_gt_1",
      ]),
    );
  });
});
