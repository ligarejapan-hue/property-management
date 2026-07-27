import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// 所有者 API が返す「紐づく物件」への field_staff 担当スコープ
// （総点検 2026-07-27 P2-2）。
//
// 物件一覧/物件詳細は canAccessPropertyRecord で担当外物件を出さないのに、
// 所有者一覧・所有者詳細だけが紐づく全物件の住所を返していた。
// src/lib/property-access.ts の規約（「個別物件 API と挙動がズレると、
// 所有者メモ等の関連経路で PII（物件住所）が漏れる」）に沿って揃える。
// 所有者メモ API (owners/[id]/memos) は既に同じ判定を適用済み。

vi.mock("@/lib/api-helpers", () => ({
  ApiError: class extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  getApiSession: vi.fn(),
  getUserPermissions: vi.fn(),
  getOwnerDisplayConfig: vi.fn(),
  apiResponse: vi.fn((body: unknown, status = 200) =>
    Response.json(body as object, { status }),
  ),
  handleApiError: vi.fn(
    (e: { status?: number; message?: string; code?: string }) =>
      Response.json(
        { error: { message: e?.message, code: e?.code } },
        { status: e?.status ?? 500 },
      ),
  ),
}));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/permissions", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/permissions")>(
      "@/lib/permissions",
    );
  // 本テストの関心は「返す物件の絞り込み」なので、権限ゲート自体は通す。
  // マスク処理 (maskValue) は実物を使う。
  return {
    ...actual,
    hasPermission: vi.fn(() => true),
    hasExplicitWritePerm: vi.fn(() => true),
  };
});
vi.mock("@/lib/change-log", () => ({
  recordChanges: vi.fn(),
  OWNER_TRACKED_FIELDS: [],
}));
vi.mock("@/lib/display-level", () => ({
  // 表示レベルは本テストの対象外。propertyOwners をそのまま素通しする。
  applyDisplayToOwner: vi.fn((owner: unknown) => owner),
}));
vi.mock("@/lib/prisma", () => ({
  default: {
    owner: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
} from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { GET as listOwners } from "@/app/api/owners/route";
import {
  GET as getOwner,
  PATCH as patchOwner,
} from "@/app/api/owners/[id]/route";

const MINE = {
  id: "p-mine",
  address: "東京都○○区 1-1-1",
  propertyType: "land",
  caseStatus: "new_case",
  createdBy: "user-1",
  assignedTo: null,
};
const NOT_MINE = {
  id: "p-other",
  address: "東京都△△区 9-9-9",
  propertyType: "land",
  caseStatus: "new_case",
  createdBy: "someone-else",
  assignedTo: "another",
};

const ownerRow = {
  id: "own-1",
  name: "山田太郎",
  nameKana: null,
  phone: null,
  zip: null,
  address: null,
  note: null,
  corporateNumber: null,
  externalLinkKey: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  version: 1,
  propertyOwners: [
    { relationship: "本人", property: MINE },
    { relationship: "本人", property: NOT_MINE },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  (getUserPermissions as Mock).mockResolvedValue([]);
  (getOwnerDisplayConfig as Mock).mockResolvedValue({
    name: "full",
    nameKana: "full",
    phone: "full",
    zip: "full",
    address: "full",
    note: "full",
    corporateNumber: "full",
  });
});

describe("GET /api/owners — 紐づく物件の担当スコープ", () => {
  it("field_staff には担当外物件の住所を返さない", async () => {
    (getApiSession as Mock).mockResolvedValue({
      id: "user-1",
      role: "field_staff",
    });
    (prisma.owner.findMany as unknown as Mock).mockResolvedValue([ownerRow]);
    (prisma.owner.count as unknown as Mock).mockResolvedValue(1);

    const res = await listOwners(
      new Request("http://localhost/api/owners") as never,
    );
    const json = (await res.json()) as {
      data: Array<{ properties: Array<{ id: string }> }>;
    };

    expect(json.data[0].properties.map((p) => p.id)).toEqual(["p-mine"]);
    expect(JSON.stringify(json)).not.toContain("東京都△△区 9-9-9");
  });

  it("office_staff には従来どおり全物件を返す（退行防止）", async () => {
    (getApiSession as Mock).mockResolvedValue({
      id: "user-1",
      role: "office_staff",
    });
    (prisma.owner.findMany as unknown as Mock).mockResolvedValue([ownerRow]);
    (prisma.owner.count as unknown as Mock).mockResolvedValue(1);

    const res = await listOwners(
      new Request("http://localhost/api/owners") as never,
    );
    const json = (await res.json()) as {
      data: Array<{ properties: Array<{ id: string }> }>;
    };

    expect(json.data[0].properties.map((p) => p.id)).toEqual([
      "p-mine",
      "p-other",
    ]);
  });

  it("担当判定に必要な列 (createdBy/assignedTo) を select している", async () => {
    (getApiSession as Mock).mockResolvedValue({
      id: "user-1",
      role: "field_staff",
    });
    (prisma.owner.findMany as unknown as Mock).mockResolvedValue([]);
    (prisma.owner.count as unknown as Mock).mockResolvedValue(0);

    await listOwners(new Request("http://localhost/api/owners") as never);

    const arg = (prisma.owner.findMany as unknown as Mock).mock.calls[0][0];
    const propSelect =
      arg.include.propertyOwners.include.property.select ??
      arg.include.propertyOwners.select?.property?.select;
    expect(propSelect.createdBy).toBe(true);
    expect(propSelect.assignedTo).toBe(true);
  });
});

describe("GET /api/owners/[id] — 紐づく物件の担当スコープ", () => {
  it("field_staff には担当外物件を含めない", async () => {
    (getApiSession as Mock).mockResolvedValue({
      id: "user-1",
      role: "field_staff",
    });
    (prisma.owner.findUnique as unknown as Mock).mockResolvedValue({
      ...ownerRow,
    });

    const res = await getOwner(new Request("http://localhost/x") as never, {
      params: Promise.resolve({ id: "own-1" }),
    });
    const json = (await res.json()) as {
      propertyOwners: Array<{ property: { id: string } }>;
    };

    expect(json.propertyOwners.map((po) => po.property.id)).toEqual(["p-mine"]);
    expect(JSON.stringify(json)).not.toContain("東京都△△区 9-9-9");
  });

  it("office_staff には従来どおり全物件を含める（退行防止）", async () => {
    (getApiSession as Mock).mockResolvedValue({
      id: "user-1",
      role: "admin",
    });
    (prisma.owner.findUnique as unknown as Mock).mockResolvedValue({
      ...ownerRow,
    });

    const res = await getOwner(new Request("http://localhost/x") as never, {
      params: Promise.resolve({ id: "own-1" }),
    });
    const json = (await res.json()) as {
      propertyOwners: Array<{ property: { id: string } }>;
    };

    expect(json.propertyOwners.map((po) => po.property.id)).toEqual([
      "p-mine",
      "p-other",
    ]);
  });
});

describe("PATCH /api/owners/[id] — 更新レスポンスにも同じスコープを適用する", () => {
  // GET だけ絞って PATCH を絞らないと、無害な更新（version だけ送る等）の
  // レスポンス経由で担当外物件の住所が漏れる（内部レビュー指摘）。
  it("field_staff には担当外物件を含めない", async () => {
    (getApiSession as Mock).mockResolvedValue({
      id: "user-1",
      role: "field_staff",
    });
    (prisma.owner.findUnique as unknown as Mock).mockResolvedValue({
      id: "own-1",
      version: 1,
      isArchived: false,
    });
    (prisma.owner.updateMany as unknown as Mock).mockResolvedValue({
      count: 1,
    });
    (prisma.owner.findUniqueOrThrow as unknown as Mock).mockResolvedValue({
      ...ownerRow,
    });

    const res = await patchOwner(
      new Request("http://localhost/x", {
        method: "PATCH",
        body: JSON.stringify({ version: 1 }),
      }) as never,
      { params: Promise.resolve({ id: "own-1" }) },
    );
    const json = (await res.json()) as {
      propertyOwners?: Array<{ property: { id: string } }>;
    };

    expect(res.status).toBe(200);
    expect(json.propertyOwners?.map((po) => po.property.id)).toEqual([
      "p-mine",
    ]);
    expect(JSON.stringify(json)).not.toContain("東京都△△区 9-9-9");
  });

  it("判定用の createdBy/assignedTo はレスポンスに載せない", async () => {
    (getApiSession as Mock).mockResolvedValue({
      id: "user-1",
      role: "admin",
    });
    (prisma.owner.findUnique as unknown as Mock).mockResolvedValue({
      id: "own-1",
      version: 1,
      isArchived: false,
    });
    (prisma.owner.updateMany as unknown as Mock).mockResolvedValue({
      count: 1,
    });
    (prisma.owner.findUniqueOrThrow as unknown as Mock).mockResolvedValue({
      ...ownerRow,
    });

    const res = await patchOwner(
      new Request("http://localhost/x", {
        method: "PATCH",
        body: JSON.stringify({ version: 1 }),
      }) as never,
      { params: Promise.resolve({ id: "own-1" }) },
    );
    const text = await res.text();

    expect(text).not.toContain("createdBy");
    expect(text).not.toContain("assignedTo");
  });
});
