/**
 * POST /api/import/registry-pdf: archived owner を既存候補にしない。
 *
 * Phase 2-A: registry PDF 取込で同名・同住所の archived owner があっても
 * 既存 Owner として再利用しない（新規 Owner を作成して PropertyOwner を作る）。
 * Active owner はこれまでどおり再利用される。
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
      { resource: "import", action: "write", granted: true },
    ]),
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

vi.mock("@/lib/permissions", () => ({
  hasPermission: vi.fn().mockReturnValue(true),
}));

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

vi.mock("@/lib/change-log", () => ({
  recordChanges: vi.fn(),
  PROPERTY_TRACKED_FIELDS: [],
}));

vi.mock("@/lib/pdf-registry-parser", () => ({
  parseRegistryText: vi.fn(),
}));

vi.mock("@/lib/pdf-extract", () => ({
  extractTextFromPdf: vi.fn(),
  isPdfBuffer: vi.fn().mockReturnValue(true),
}));

vi.mock("@/lib/prisma", () => {
  const tx = {
    owner: { updateMany: vi.fn() },
    propertyOwner: { findFirst: vi.fn(), create: vi.fn() },
  };
  return {
    default: {
      property: { findUnique: vi.fn(), updateMany: vi.fn() },
      owner: { findMany: vi.fn(), create: vi.fn() },
      propertyOwner: { findFirst: vi.fn(), create: vi.fn() },
      importJob: { create: vi.fn(), update: vi.fn() },
      importJobRow: { create: vi.fn() },
      $transaction: vi
        .fn()
        .mockImplementation((fn: (tx: unknown) => unknown) => fn(tx)),
      _tx: tx,
    },
  };
});

import prisma from "@/lib/prisma";
import { parseRegistryText } from "@/lib/pdf-registry-parser";
import { POST as REGISTRY_PDF_POST } from "../../app/api/import/registry-pdf/route";

const PROPERTY_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_NAME = "山田太郎";
const OWNER_ADDRESS = "東京都港区1-1";

const pm = prisma as unknown as {
  property: { findUnique: Mock; updateMany: Mock };
  owner: { findMany: Mock; create: Mock };
  propertyOwner: { findFirst: Mock; create: Mock };
  importJob: { create: Mock; update: Mock };
  importJobRow: { create: Mock };
  $transaction: Mock;
  _tx: {
    owner: { updateMany: Mock };
    propertyOwner: { findFirst: Mock; create: Mock };
  };
};

function makeRequest() {
  const __payload = JSON.stringify({
      text: "dummy registry text",
      propertyId: PROPERTY_ID,
      fileName: "registry.pdf",
    });
      return new Request("http://localhost/api/import/registry-pdf", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "content-length": String(Buffer.byteLength(__payload)),
      },
      body: __payload,
      }) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(parseRegistryText).mockReturnValue({
    realEstateNumber: "1234",
    address: OWNER_ADDRESS,
    lotNumber: null,
    buildingNumber: null,
    owners: [{ name: OWNER_NAME, address: OWNER_ADDRESS, share: null }],
    warnings: [],
    confidence: 0.9,
  } as unknown as ReturnType<typeof parseRegistryText>);

  pm.property.findUnique.mockResolvedValue({
    id: PROPERTY_ID,
    version: 1,
    realEstateNumber: null,
    lotNumber: null,
    buildingNumber: null,
    registryStatus: "unconfirmed",
  });
  pm.property.updateMany.mockResolvedValue({ count: 1 });
  pm.importJob.create.mockResolvedValue({ id: "job-1" });
  pm.importJob.update.mockResolvedValue({});
  pm.importJobRow.create.mockResolvedValue({});
  pm.propertyOwner.findFirst.mockResolvedValue(null);
  pm.propertyOwner.create.mockResolvedValue({});
  pm.owner.create.mockImplementation(({ data }: { data: { name: string } }) =>
    Promise.resolve({ id: `owner-${data.name}` }),
  );
  // transaction proxy + デフォルト: 既存 owner branch で lock 成功 (count=1) と
  // PropertyOwner 未 link を返す。レーステストで個別 override する。
  pm.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(pm._tx),
  );
  pm._tx.owner.updateMany.mockResolvedValue({ count: 1 });
  pm._tx.propertyOwner.findFirst.mockResolvedValue(null);
  pm._tx.propertyOwner.create.mockResolvedValue({});
});

describe("POST /api/import/registry-pdf: archived owner を既存候補にしない", () => {
  it("dedup findMany の where に isArchived:false が含まれる", async () => {
    pm.owner.findMany.mockResolvedValue([]);

    await REGISTRY_PDF_POST(makeRequest());

    expect(pm.owner.findMany).toHaveBeenCalled();
    const call = pm.owner.findMany.mock.calls.find(
      (c) =>
        c[0]?.where?.address &&
        Object.prototype.hasOwnProperty.call(c[0].where, "isArchived"),
    );
    expect(call).toBeDefined();
    expect(call![0].where).toMatchObject({
      address: { not: null },
      isArchived: false,
    });
  });

  it("archived owner と name/address が一致しても再利用せず、新規 Owner + PropertyOwner を作成", async () => {
    // DB 側 where: { isArchived: false } によって archived は除外されるため []
    pm.owner.findMany.mockResolvedValue([]);

    await REGISTRY_PDF_POST(makeRequest());

    // 新規 Owner 作成
    expect(pm.owner.create).toHaveBeenCalledTimes(1);
    expect(pm.owner.create).toHaveBeenCalledWith({
      data: { name: OWNER_NAME, address: OWNER_ADDRESS },
      select: { id: true },
    });
    // PropertyOwner 作成（新規 Owner と link）
    expect(pm.propertyOwner.create).toHaveBeenCalledTimes(1);
    const linkArgs = pm.propertyOwner.create.mock.calls[0][0];
    expect(linkArgs.data.propertyId).toBe(PROPERTY_ID);
    expect(linkArgs.data.ownerId).toBe(`owner-${OWNER_NAME}`);
  });

  it("active owner と name/address が一致した場合は再利用（新規 Owner を作らず tx 内で PropertyOwner を作る）", async () => {
    pm.owner.findMany.mockResolvedValue([
      { id: "existing-active", name: OWNER_NAME, address: OWNER_ADDRESS },
    ]);
    // tx 内 lock+verify 成功
    pm._tx.owner.updateMany.mockResolvedValue({ count: 1 });

    await REGISTRY_PDF_POST(makeRequest());

    // 新規 Owner は作らない
    expect(pm.owner.create).not.toHaveBeenCalled();
    // PropertyOwner は tx 内で既存 active owner と link
    expect(pm._tx.propertyOwner.create).toHaveBeenCalledTimes(1);
    const linkArgs = pm._tx.propertyOwner.create.mock.calls[0][0];
    expect(linkArgs.data.ownerId).toBe("existing-active");
    // tx 内 updateMany は { id, isArchived: false } で行ロック取得
    const lockArgs = pm._tx.owner.updateMany.mock.calls[0][0];
    expect(lockArgs.where).toEqual({
      id: "existing-active",
      isArchived: false,
    });
  });

  it("レース: lookup 後 concurrent archive で lock count=0 → archived owner には link せず新規 active Owner で fallback", async () => {
    // dedup find は active owner を返す
    pm.owner.findMany.mockResolvedValue([
      { id: "owner-raced", name: OWNER_NAME, address: OWNER_ADDRESS },
    ]);
    // しかし tx 内 lock は count=0（同時 archive で isArchived=true になった）
    pm._tx.owner.updateMany.mockResolvedValue({ count: 0 });

    await REGISTRY_PDF_POST(makeRequest());

    // archived owner には PropertyOwner を作らない（tx 内 createは呼ばれない）
    expect(pm._tx.propertyOwner.create).not.toHaveBeenCalled();
    // fallback で新規 active Owner を作成
    expect(pm.owner.create).toHaveBeenCalledTimes(1);
    // PropertyOwner は新規 owner と link（fallback パスは prisma 直叩き）
    expect(pm.propertyOwner.create).toHaveBeenCalledTimes(1);
    const linkArgs = pm.propertyOwner.create.mock.calls[0][0];
    expect(linkArgs.data.ownerId).toBe(`owner-${OWNER_NAME}`);
    expect(linkArgs.data.ownerId).not.toBe("owner-raced");
  });
});
