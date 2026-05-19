/**
 * POST /api/import/reception-owner: archived owner との race-safety テスト。
 *
 * 既存 Owner を再利用するパスで、lookup と PropertyOwner.create の間に
 * concurrent archive が走った場合、archived owner には絶対に link しない。
 * fallback で新規 active Owner を作成して link する。
 *
 * 既存挙動:
 *   - active owner match → tx 内 lock 成功 → tx 内 PropertyOwner.create
 *   - dedup ヒットなし → 新規 Owner 作成（fallback と同じパス）
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
        {
          error: {
            message: error instanceof Error ? error.message : "Server error",
            code: "INTERNAL_ERROR",
          },
        },
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

vi.mock("@/lib/sheet-parser", () => ({
  parseSheet: vi.fn().mockReturnValue({ headers: [], rows: [] }),
  SheetParseError: class extends Error {
    code: string;
    constructor(msg: string, code: string) {
      super(msg);
      this.code = code;
    }
  },
}));

vi.mock("@/lib/import-file-type", () => ({
  detectImportFileType: vi.fn().mockImplementation((name: string) => {
    if (name.includes("reception") || name.includes("受付帳"))
      return { type: "reception" };
    if (name.includes("owner") || name.includes("所有者"))
      return { type: "owner" };
    return { type: null, error: "unknown" };
  }),
}));

vi.mock("@/lib/import-error-display", () => ({
  buildErrorRawDataExtras: vi.fn().mockReturnValue({}),
}));

vi.mock("@/lib/reception-owner-link", () => ({
  RECEPTION_OWNER_LINK_DATA_KEY: "__owner_link_data",
}));

vi.mock("@/lib/reception-owner-match", () => ({
  parseReceptionRows: vi.fn(),
  parseOwnerRows: vi.fn(),
  buildCombinedMatches: vi.fn(),
  summarizeMatches: vi.fn(),
  getReviewReason: vi.fn(),
  applyReceptionFilters: vi.fn(),
  DEFAULT_RECEPTION_FILTER_OPTIONS: { dl: "all", shinki: "all" },
  REVIEW_REASON_LABEL: {},
}));

const PROPERTY_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_NAME = "佐々木一郎";
const OWNER_ADDRESS = "北海道札幌市中央区1-1";

vi.mock("@/lib/prisma", () => {
  const tx = {
    owner: { updateMany: vi.fn() },
    propertyOwner: { findUnique: vi.fn(), create: vi.fn() },
  };
  return {
    default: {
      property: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
      owner: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      propertyOwner: { findUnique: vi.fn(), create: vi.fn() },
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
import {
  parseReceptionRows,
  parseOwnerRows,
  buildCombinedMatches,
  summarizeMatches,
  getReviewReason,
  applyReceptionFilters,
} from "@/lib/reception-owner-match";
import { POST } from "../../app/api/import/reception-owner/route";

const pm = prisma as unknown as {
  property: { findMany: Mock; update: Mock; updateMany: Mock };
  owner: {
    findMany: Mock;
    findFirst: Mock;
    create: Mock;
    update: Mock;
  };
  propertyOwner: { findUnique: Mock; create: Mock };
  importJob: { create: Mock; update: Mock };
  importJobRow: { create: Mock };
  $transaction: Mock;
  _tx: {
    owner: { updateMany: Mock };
    propertyOwner: { findUnique: Mock; create: Mock };
  };
};

function makeRequest() {
  return new Request("http://localhost/api/import/reception-owner", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      receptionCsv: "dummy reception csv",
      ownerCsv: "dummy owner csv",
      receptionFileName: "受付帳.csv",
      ownerFileName: "所有者.csv",
    }),
  }) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  // reception-owner-match のモック値はここで設定（hoisted factory では PROPERTY_ID
  // 等の top-level 変数を参照できないため）。
  vi.mocked(parseReceptionRows).mockReturnValue([{ rowNumber: 1 } as never]);
  vi.mocked(parseOwnerRows).mockReturnValue([]);
  vi.mocked(buildCombinedMatches).mockReturnValue([
    {
      reception: {
        rowNumber: 1,
        matchKey: "k",
        fColumn: "",
        kColumn: "",
        lotNumber: "",
        buildingNumber: "",
        coOwnersNote: "",
        shinkiValue: "",
        dlMarked: false,
      },
      propertyMatch: {
        status: "matched",
        property: { id: PROPERTY_ID },
      },
      owners: [
        {
          name: OWNER_NAME,
          address: OWNER_ADDRESS,
          zip: null,
          dm: "",
          propertyAddress: "",
          roomNo: null,
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  ]);
  vi.mocked(summarizeMatches).mockReturnValue({
    matched: 1,
    unmatched: 0,
    ambiguous: 0,
    noOwners: 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  vi.mocked(getReviewReason).mockReturnValue(null);
  vi.mocked(applyReceptionFilters).mockImplementation(
    (rows: unknown) => rows as never,
  );

  pm.property.findMany.mockResolvedValue([
    {
      id: PROPERTY_ID,
      address: "",
      lotNumber: null,
      buildingNumber: null,
      roomNo: null,
      dmStatus: "hold",
      building: null,
    },
  ]);
  pm.property.update.mockResolvedValue({});
  pm.property.updateMany.mockResolvedValue({ count: 0 });
  pm.importJob.create.mockResolvedValue({ id: "job-1" });
  pm.importJob.update.mockResolvedValue({});
  pm.importJobRow.create.mockResolvedValue({});
  pm.owner.create.mockImplementation(({ data }: { data: { name: string } }) =>
    Promise.resolve({ id: `owner-${data.name}` }),
  );
  pm.propertyOwner.findUnique.mockResolvedValue(null);
  pm.propertyOwner.create.mockResolvedValue({});

  pm.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(pm._tx),
  );
  pm._tx.owner.updateMany.mockResolvedValue({ count: 1 });
  pm._tx.propertyOwner.findUnique.mockResolvedValue(null);
  pm._tx.propertyOwner.create.mockResolvedValue({});
});

describe("POST /api/import/reception-owner: archive race-safety", () => {
  it("active owner と name/address が一致 → tx 内で既存 owner に link（reuse）", async () => {
    pm.owner.findMany.mockResolvedValue([
      {
        id: "existing-active",
        name: OWNER_NAME,
        address: OWNER_ADDRESS,
        zip: null,
      },
    ]);
    pm._tx.owner.updateMany.mockResolvedValue({ count: 1 });

    const res = await POST(makeRequest());
    expect([200, 201]).toContain(res.status);

    // 新規 Owner は作らない
    expect(pm.owner.create).not.toHaveBeenCalled();
    // tx 内で既存 owner に link
    expect(pm._tx.propertyOwner.create).toHaveBeenCalledTimes(1);
    expect(pm._tx.propertyOwner.create.mock.calls[0][0].data.ownerId).toBe(
      "existing-active",
    );
    // lock+verify の where が isArchived=false を含む
    const lockArgs = pm._tx.owner.updateMany.mock.calls[0][0];
    expect(lockArgs.where).toEqual({
      id: "existing-active",
      isArchived: false,
    });
  });

  it("dedup ヒットなし → 新規 Owner 作成 + 通常 link", async () => {
    pm.owner.findMany.mockResolvedValue([]);
    pm.owner.findFirst.mockResolvedValue(null);

    const res = await POST(makeRequest());
    expect([200, 201]).toContain(res.status);

    // 新規 Owner 作成（prisma 直叩き）
    expect(pm.owner.create).toHaveBeenCalledTimes(1);
    // tx 内 link は呼ばれない（fallback パスは prisma 直叩き）
    expect(pm._tx.propertyOwner.create).not.toHaveBeenCalled();
    // 通常 link
    expect(pm.propertyOwner.create).toHaveBeenCalledTimes(1);
    expect(pm.propertyOwner.create.mock.calls[0][0].data.ownerId).toBe(
      `owner-${OWNER_NAME}`,
    );
  });

  it("レース: lookup 後 concurrent archive で lock count=0 → archived には link せず新規 active Owner で fallback", async () => {
    pm.owner.findMany.mockResolvedValue([
      {
        id: "owner-raced",
        name: OWNER_NAME,
        address: OWNER_ADDRESS,
        zip: null,
      },
    ]);
    // tx 内 lock は archive race で count=0
    pm._tx.owner.updateMany.mockResolvedValue({ count: 0 });

    const res = await POST(makeRequest());
    expect([200, 201]).toContain(res.status);

    // archived owner には PropertyOwner を作らない
    expect(pm._tx.propertyOwner.create).not.toHaveBeenCalled();
    // fallback で新規 active Owner を作成
    expect(pm.owner.create).toHaveBeenCalledTimes(1);
    expect(pm.owner.create.mock.calls[0][0].data.name).toBe(OWNER_NAME);
    // PropertyOwner は新規 owner と link（fallback パス）
    expect(pm.propertyOwner.create).toHaveBeenCalledTimes(1);
    const linkArgs = pm.propertyOwner.create.mock.calls[0][0];
    expect(linkArgs.data.ownerId).toBe(`owner-${OWNER_NAME}`);
    expect(linkArgs.data.ownerId).not.toBe("owner-raced");
  });

  it("API レスポンスに PII (name / address) を増やさない", async () => {
    pm.owner.findMany.mockResolvedValue([
      {
        id: "existing-active",
        name: OWNER_NAME,
        address: OWNER_ADDRESS,
        zip: null,
      },
    ]);

    const res = await POST(makeRequest());
    const text = await res.text();
    // 本 API のレスポンスは job サマリのみ。owner name/address は載せない。
    expect(text).not.toContain(OWNER_NAME);
    expect(text).not.toContain(OWNER_ADDRESS);
  });
});
