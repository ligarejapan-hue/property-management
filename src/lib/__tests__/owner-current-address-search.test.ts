/**
 * 現住所で「探せる／見える」ことを、検索の 3 入口すべてで固定する。
 *
 * 設計: docs/superpowers/specs/2026-08-10-owner-current-address-design.md §5
 *
 * 守りたいこと:
 *  1. 現住所へ引っ越した人を、現住所の文字で探せる（入口ごとの足し忘れを防ぐ）。
 *  2. 当たった値が画面に返る（返さないと「なぜこの人が出たのか」が分からず別人を選ぶ）。
 *  3. ⚠住所がマスクされている利用者では**検索対象にしない**。
 *     ヒットの有無だけで見えないはずの住所を当てられる（検索オラクル）ため、
 *     登記上の住所と同じ規則に揃える。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {
    nextUrl: URL;
    constructor(input: string | URL | Request, init?: RequestInit) {
      super(input, init);
      this.nextUrl = new URL(
        typeof input === "string" ? input : (input as Request).url,
      );
    }
  }
  return { NextRequest: MockNextRequest };
});

const FULL_CONFIG = {
  name: "full",
  nameKana: "full",
  phone: "full",
  zip: "full",
  address: "full",
  note: "full",
  email: "full",
  corporateNumber: "full",
};

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
    getApiSession: vi.fn(),
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
    owner: { findMany: vi.fn(), count: vi.fn() },
    property: { findMany: vi.fn() },
    importJobRow: { findMany: vi.fn() },
    $queryRaw: vi.fn().mockResolvedValue([]),
  },
}));

import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
} from "@/lib/api-helpers";
import { GET as ownersSearchGET } from "../../app/api/owners/search/route";
import { GET as ownersListGET } from "../../app/api/owners/route";
import { POST as suggestPOST } from "../../app/api/properties/suggest/route";

const pm = prisma as unknown as {
  owner: { findMany: Mock; count: Mock };
  property: { findMany: Mock };
  importJobRow: { findMany: Mock };
};

const PERMS = [
  { resource: "property", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
];

/** 現住所へ引っ越し済みの所有者（登記上は旧住所のまま）。 */
const MOVED_OWNER = {
  id: "o1",
  name: "山田太郎",
  nameKana: null,
  phone: null,
  zip: "231-0842",
  address: "横浜市南区井土ケ谷中町69-2",
  currentZip: "150-0001",
  currentAddress: "渋谷区神宮前1-1-1",
  note: null,
  corporateNumber: null,
  externalLinkKey: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  version: 1,
  propertyOwners: [],
};

function setDisplayConfig(overrides: Record<string, string> = {}) {
  vi.mocked(getOwnerDisplayConfig).mockResolvedValue({
    ...FULL_CONFIG,
    ...overrides,
  } as never);
}

/** 条件木（OR/AND のネスト）を平らにして「この列が検索対象か」を判定する。 */
function mentionsField(node: unknown, field: string): boolean {
  if (node == null || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some((n) => mentionsField(n, field));
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === field) return true;
    if (mentionsField(value, field)) return true;
  }
  return false;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApiSession).mockResolvedValue({
    id: "user-admin",
    email: "a@a",
    name: "A",
    role: "admin",
  } as never);
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS as never);
  setDisplayConfig();
  pm.owner.findMany.mockResolvedValue([]);
  pm.owner.count.mockResolvedValue(0);
  pm.property.findMany.mockResolvedValue([]);
  pm.importJobRow.findMany.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// 入口1: 所有者検索（取込の紐付け・所有者の付け替えで使う）
// ---------------------------------------------------------------------------

describe("GET /api/owners/search", () => {
  // この route は request.nextUrl を読む（素の Request には無い）。
  const call = (q: string) => {
    const url = `http://localhost/api/owners/search?q=${encodeURIComponent(q)}`;
    const req = new Request(url) as Request & { nextUrl: URL };
    req.nextUrl = new URL(url);
    return ownersSearchGET(req as never);
  };

  it("現住所の文字で探せる", async () => {
    await call("神宮前");
    const where = pm.owner.findMany.mock.calls[0][0].where;
    expect(mentionsField(where.OR, "currentAddress")).toBe(true);
  });

  it("当たった現住所を画面へ返す", async () => {
    pm.owner.findMany.mockResolvedValue([MOVED_OWNER]);
    const res = await call("神宮前");
    const body = await res.json();
    expect(body.data[0].currentAddress).toBe("渋谷区神宮前1-1-1");
    expect(body.data[0].address).toBe("横浜市南区井土ケ谷中町69-2");
  });

  it("⚠住所がマスクの利用者では現住所も検索対象にしない（検索オラクル封じ）", async () => {
    setDisplayConfig({ address: "partial" });
    await call("神宮前");
    const where = pm.owner.findMany.mock.calls[0][0].where;
    expect(mentionsField(where.OR, "currentAddress")).toBe(false);
    expect(mentionsField(where.OR, "address")).toBe(false);
  });

  it("⚠マスクの利用者へ現住所の生値を返さない", async () => {
    setDisplayConfig({ address: "partial" });
    pm.owner.findMany.mockResolvedValue([MOVED_OWNER]);
    // 氏名でヒットした場合でも、現住所は生値で出さない。
    const res = await call("山田");
    const body = await res.json();
    if (body.data.length > 0) {
      expect(body.data[0].currentAddress).not.toBe("渋谷区神宮前1-1-1");
    }
  });
});

// ---------------------------------------------------------------------------
// 入口2: 所有者一覧
// ---------------------------------------------------------------------------

describe("GET /api/owners", () => {
  const call = (keyword: string) =>
    ownersListGET(
      new Request(
        `http://localhost/api/owners?keyword=${encodeURIComponent(keyword)}`,
      ) as never,
    );

  it("現住所の文字で探せる", async () => {
    await call("神宮前");
    const where = pm.owner.findMany.mock.calls[0][0].where;
    expect(mentionsField(where.OR, "currentAddress")).toBe(true);
  });

  it("当たった現住所を画面へ返す（郵便番号も）", async () => {
    pm.owner.findMany.mockResolvedValue([MOVED_OWNER]);
    pm.owner.count.mockResolvedValue(1);
    const res = await call("神宮前");
    const body = await res.json();
    expect(body.data[0].currentAddress).toBe("渋谷区神宮前1-1-1");
    expect(body.data[0].currentZip).toBe("150-0001");
  });
});

// ---------------------------------------------------------------------------
// 入口3: 物件一覧の入力中候補
// ---------------------------------------------------------------------------

describe("POST /api/properties/suggest", () => {
  const call = (q: string) =>
    suggestPOST(
      new Request("http://localhost/api/properties/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q }),
      }) as never,
    );

  const listCall = () =>
    pm.property.findMany.mock.calls.find(
      (c: unknown[]) => (c[0] as { take?: number })?.take === 10,
    ) as unknown[];

  it("所有者の現住所の文字で物件を探せる", async () => {
    await call("神宮前");
    const where = (listCall()[0] as { where: unknown }).where;
    expect(mentionsField(where, "currentAddress")).toBe(true);
  });

  it("当たった現住所を候補行に返す", async () => {
    pm.property.findMany.mockResolvedValue([
      {
        id: "p1",
        address: "物件所在地",
        dmStatus: "send",
        propertyOwners: [{ owner: MOVED_OWNER }],
      },
    ]);
    const res = await call("神宮前");
    const body = await res.json();
    expect(body.data[0].owners[0].currentAddress).toBe("渋谷区神宮前1-1-1");
  });

  it("⚠住所がマスクの利用者では現住所も検索対象にしない（検索オラクル封じ）", async () => {
    setDisplayConfig({ address: "partial" });
    await call("神宮前");
    const where = (listCall()[0] as { where: unknown }).where;
    expect(mentionsField(where, "currentAddress")).toBe(false);
  });

  it("⚠郵便番号がマスクの利用者では現住所の郵便番号も検索対象にしない", async () => {
    setDisplayConfig({ zip: "hidden" });
    await call("150-0001");
    const where = (listCall()[0] as { where: unknown }).where;
    expect(mentionsField(where, "currentZip")).toBe(false);
  });

  it("owner:read が無い利用者には現住所を返さない", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue([
      { resource: "property", action: "read", granted: true },
    ] as never);
    pm.property.findMany.mockResolvedValue([
      {
        id: "p1",
        address: "物件所在地",
        dmStatus: "send",
        propertyOwners: [{ owner: MOVED_OWNER }],
      },
    ]);
    const res = await call("神宮前");
    const body = await res.json();
    expect(body.data[0].owners[0].currentAddress).toBeNull();
    expect(body.data[0].owners[0].currentZip).toBeNull();
  });
});
