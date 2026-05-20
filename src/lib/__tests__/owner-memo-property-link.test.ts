/**
 * GET / POST /api/owners/[id]/memos の propertyId 機能テスト。
 *
 * - POST: propertyId 任意受付、検証（UUID 形式・property:read 必須・isArchived=false）
 * - GET: property:read を持つユーザーに property 情報を返す
 * - AuditLog detail に propertyId を入れる（本文・PII は入れない）
 * - 既存挙動（propertyId なし）が壊れていないこと
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
    getApiSession: vi.fn(),
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

vi.mock("@/lib/prisma", () => {
  const tx = {
    owner: { updateMany: vi.fn() },
    ownerMemo: { create: vi.fn() },
  };
  return {
    default: {
      owner: { findUnique: vi.fn() },
      property: { findUnique: vi.fn() },
      propertyOwner: { findFirst: vi.fn() },
      ownerMemo: { findMany: vi.fn() },
      $transaction: vi
        .fn()
        .mockImplementation((fn: (tx: unknown) => unknown) => fn(tx)),
      _tx: tx,
    },
  };
});

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import {
  GET,
  POST,
} from "../../app/api/owners/[id]/memos/route";

const OWNER_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const PROPERTY_ID = "bbbbbbbb-0000-4000-8000-000000000001";
const PROPERTY_ADDRESS = "東京都港区テスト1-1";
const OWNER_NAME = "メモ太郎";
const MEMO_BODY = "電話応対メモ。次回再連絡。";

const pm = prisma as unknown as {
  owner: { findUnique: Mock };
  property: { findUnique: Mock };
  propertyOwner: { findFirst: Mock };
  ownerMemo: { findMany: Mock };
  $transaction: Mock;
  _tx: {
    owner: { updateMany: Mock };
    ownerMemo: { create: Mock };
  };
};

function makeRequest(body: unknown, method: "GET" | "POST" = "POST") {
  return new Request(`http://localhost/api/owners/${OWNER_ID}/memos`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  }) as unknown as import("next/server").NextRequest;
}

const makeParams = () => ({ params: Promise.resolve({ id: OWNER_ID }) });

const FULL_PERMS = [
  { resource: "owner", action: "read", granted: true },
  { resource: "owner", action: "write", granted: true },
  { resource: "owner_note", action: "edit", granted: true },
  { resource: "property", action: "read", granted: true },
];

const PERMS_WITHOUT_PROPERTY_READ = [
  { resource: "owner", action: "read", granted: true },
  { resource: "owner", action: "write", granted: true },
  { resource: "owner_note", action: "edit", granted: true },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApiSession).mockResolvedValue({
    id: "user-1",
    email: "admin@test.com",
    name: "Admin",
    role: "admin",
  });
  vi.mocked(getUserPermissions).mockResolvedValue(FULL_PERMS);
  pm.owner.findUnique.mockResolvedValue({ id: OWNER_ID, isArchived: false });
  // デフォルト: admin / property の createdBy/assignedTo はテスト側で意識しない
  pm.property.findUnique.mockResolvedValue({
    id: PROPERTY_ID,
    isArchived: false,
    createdBy: "creator-1",
    assignedTo: "assignee-1",
  });
  // デフォルト: owner と property が紐づいている状態
  pm.propertyOwner.findFirst.mockResolvedValue({ id: "po-1" });
  // tx mock のデフォルト: lock 成功 (count=1)
  pm.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(pm._tx),
  );
  pm._tx.owner.updateMany.mockResolvedValue({ count: 1 });
});

// ── POST tests ─────────────────────────────────────────────────────────────

describe("POST /api/owners/[id]/memos: propertyId 任意受付", () => {
  it("propertyId なしで作成成功（既存挙動）", async () => {
    pm._tx.ownerMemo.create.mockResolvedValue({
      id: "memo-1",
      ownerId: OWNER_ID,
      propertyId: null,
      body: MEMO_BODY,
      createdAt: new Date(),
      creator: { id: "user-1", name: "Admin", email: "a@test.com" },
      property: null,
    });

    const res = await POST(makeRequest({ body: MEMO_BODY }), makeParams());
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.propertyId).toBeNull();
    expect(json.property).toBeNull();
    expect(pm.property.findUnique).not.toHaveBeenCalled();
    // propertyId なしなら link check も走らない
    expect(pm.propertyOwner.findFirst).not.toHaveBeenCalled();
    // AuditLog: propertyId=null が detail に含まれる
    const auditCall = vi.mocked(writeAuditLog).mock.calls[0][0];
    expect(auditCall.detail).toMatchObject({
      ownerId: OWNER_ID,
      memoId: "memo-1",
      propertyId: null,
      bodyLength: MEMO_BODY.length,
    });
  });

  it("propertyId 指定 + owner と紐づきあり → 作成成功", async () => {
    pm._tx.ownerMemo.create.mockResolvedValue({
      id: "memo-2",
      ownerId: OWNER_ID,
      propertyId: PROPERTY_ID,
      body: MEMO_BODY,
      createdAt: new Date(),
      creator: { id: "user-1", name: "Admin", email: "a@test.com" },
      property: { id: PROPERTY_ID, address: PROPERTY_ADDRESS },
    });

    const res = await POST(
      makeRequest({ body: MEMO_BODY, propertyId: PROPERTY_ID }),
      makeParams(),
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.propertyId).toBe(PROPERTY_ID);
    expect(json.property).toEqual({
      id: PROPERTY_ID,
      address: PROPERTY_ADDRESS,
    });
    // Property の存在・未 archived 確認 + scope 判定用フィールド取得
    expect(pm.property.findUnique).toHaveBeenCalledWith({
      where: { id: PROPERTY_ID },
      select: {
        id: true,
        isArchived: true,
        createdBy: true,
        assignedTo: true,
      },
    });
    // owner ↔ property の link 確認
    expect(pm.propertyOwner.findFirst).toHaveBeenCalledWith({
      where: { ownerId: OWNER_ID, propertyId: PROPERTY_ID },
      select: { id: true },
    });
    // ownerMemo.create に propertyId が渡る
    const createArgs = pm._tx.ownerMemo.create.mock.calls[0][0];
    expect(createArgs.data.propertyId).toBe(PROPERTY_ID);
  });

  it("owner と property が紐づいていない → 422 INVALID_OWNER_PROPERTY_LINK / OwnerMemo.create 呼ばれない", async () => {
    // owner も property も存在するが PropertyOwner link がない
    pm.propertyOwner.findFirst.mockResolvedValue(null);

    const res = await POST(
      makeRequest({ body: MEMO_BODY, propertyId: PROPERTY_ID }),
      makeParams(),
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.code).toBe("INVALID_OWNER_PROPERTY_LINK");
    // PropertyOwner check は走った
    expect(pm.propertyOwner.findFirst).toHaveBeenCalledWith({
      where: { ownerId: OWNER_ID, propertyId: PROPERTY_ID },
      select: { id: true },
    });
    // OwnerMemo は作られない
    expect(pm._tx.ownerMemo.create).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
    // PII 漏れ防止: response に PROPERTY_ADDRESS / OWNER_NAME / MEMO_BODY が含まれない
    const text = JSON.stringify(json);
    expect(text).not.toContain(PROPERTY_ADDRESS);
    expect(text).not.toContain(OWNER_NAME);
    expect(text).not.toContain(MEMO_BODY);
  });

  it("存在しない propertyId → 404", async () => {
    pm.property.findUnique.mockResolvedValue(null);

    const res = await POST(
      makeRequest({ body: MEMO_BODY, propertyId: PROPERTY_ID }),
      makeParams(),
    );
    expect(res.status).toBe(404);
    expect(pm._tx.ownerMemo.create).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("archived property → 404", async () => {
    pm.property.findUnique.mockResolvedValue({
      id: PROPERTY_ID,
      isArchived: true,
    });

    const res = await POST(
      makeRequest({ body: MEMO_BODY, propertyId: PROPERTY_ID }),
      makeParams(),
    );
    expect(res.status).toBe(404);
    expect(pm._tx.ownerMemo.create).not.toHaveBeenCalled();
  });

  it("property:read なしで propertyId 指定 → 403、property.findUnique 呼ばれない", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(
      PERMS_WITHOUT_PROPERTY_READ,
    );

    const res = await POST(
      makeRequest({ body: MEMO_BODY, propertyId: PROPERTY_ID }),
      makeParams(),
    );
    expect(res.status).toBe(403);
    expect(pm.property.findUnique).not.toHaveBeenCalled();
    expect(pm._tx.ownerMemo.create).not.toHaveBeenCalled();
  });

  it("propertyId が UUID 形式でない → 422", async () => {
    const res = await POST(
      makeRequest({ body: MEMO_BODY, propertyId: "not-a-uuid" }),
      makeParams(),
    );
    expect(res.status).toBe(422);
    expect(pm.property.findUnique).not.toHaveBeenCalled();
    expect(pm._tx.ownerMemo.create).not.toHaveBeenCalled();
  });

  it("AuditLog detail に本文・PII（owner名 / address）が含まれない", async () => {
    pm._tx.ownerMemo.create.mockResolvedValue({
      id: "memo-pii",
      ownerId: OWNER_ID,
      propertyId: PROPERTY_ID,
      body: MEMO_BODY,
      createdAt: new Date(),
      creator: null,
      property: { id: PROPERTY_ID, address: PROPERTY_ADDRESS },
    });

    await POST(
      makeRequest({ body: MEMO_BODY, propertyId: PROPERTY_ID }),
      makeParams(),
    );
    const call = vi.mocked(writeAuditLog).mock.calls[0][0];
    const serialized = JSON.stringify(call.detail);
    expect(serialized).not.toContain(MEMO_BODY);
    expect(serialized).not.toContain(OWNER_NAME);
    expect(serialized).not.toContain(PROPERTY_ADDRESS);
    expect(call.detail).toMatchObject({
      ownerId: OWNER_ID,
      memoId: "memo-pii",
      propertyId: PROPERTY_ID,
      bodyLength: MEMO_BODY.length,
    });
  });
});

// ── GET tests ──────────────────────────────────────────────────────────────

describe("GET /api/owners/[id]/memos: propertyId / property 返却", () => {
  it("property:read あり → propertyId つきメモは property 情報を返す", async () => {
    pm.ownerMemo.findMany.mockResolvedValue([
      {
        id: "memo-1",
        ownerId: OWNER_ID,
        propertyId: PROPERTY_ID,
        body: MEMO_BODY,
        createdAt: new Date(),
        creator: { id: "user-1", name: "Admin", email: "a@test.com" },
        property: {
          id: PROPERTY_ID,
          address: PROPERTY_ADDRESS,
          createdBy: "creator-1",
          assignedTo: "assignee-1",
        },
      },
    ]);

    const res = await GET(makeRequest({}, "GET"), makeParams());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.memos).toHaveLength(1);
    expect(json.memos[0].propertyId).toBe(PROPERTY_ID);
    expect(json.memos[0].property).toEqual({
      id: PROPERTY_ID,
      address: PROPERTY_ADDRESS,
    });
  });

  it("propertyId=null のメモは property=null", async () => {
    pm.ownerMemo.findMany.mockResolvedValue([
      {
        id: "memo-2",
        ownerId: OWNER_ID,
        propertyId: null,
        body: MEMO_BODY,
        createdAt: new Date(),
        creator: null,
        property: null,
      },
    ]);

    const res = await GET(makeRequest({}, "GET"), makeParams());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.memos[0].propertyId).toBeNull();
    expect(json.memos[0].property).toBeNull();
  });

  it("property:read なし → propertyId は返るが property は null", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(
      PERMS_WITHOUT_PROPERTY_READ,
    );
    pm.ownerMemo.findMany.mockResolvedValue([
      {
        id: "memo-3",
        ownerId: OWNER_ID,
        propertyId: PROPERTY_ID,
        body: MEMO_BODY,
        createdAt: new Date(),
        creator: null,
        // route 内で常に include するが、レスポンス時に property:read で分岐する
        property: {
          id: PROPERTY_ID,
          address: PROPERTY_ADDRESS,
          createdBy: "creator-1",
          assignedTo: "assignee-1",
        },
      },
    ]);

    const res = await GET(makeRequest({}, "GET"), makeParams());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.memos[0].propertyId).toBe(PROPERTY_ID);
    expect(json.memos[0].property).toBeNull();
    // PII 漏れ防止: レスポンス全体に address が含まれない
    const text = JSON.stringify(json);
    expect(text).not.toContain(PROPERTY_ADDRESS);
  });
});

// ── field_staff レコードスコープ判定 ────────────────────────────────────────
// 物件詳細 API と同じスコープ: field_staff は createdBy / assignedTo のみアクセス可。
// property:read 権限だけでは個別物件を見られないユーザーに、OwnerMemo 経由で
// 物件 PII (address) を漏らさない。

describe("POST /api/owners/[id]/memos: field_staff レコードスコープ", () => {
  beforeEach(() => {
    vi.mocked(getApiSession).mockResolvedValue({
      id: "field-staff-1",
      email: "field@test.com",
      name: "Field",
      role: "field_staff",
    });
  });

  it("field_staff + 自身が createdBy の物件 → 成功（propertyId 保存）", async () => {
    pm.property.findUnique.mockResolvedValue({
      id: PROPERTY_ID,
      isArchived: false,
      createdBy: "field-staff-1",
      assignedTo: null,
    });
    pm._tx.ownerMemo.create.mockResolvedValue({
      id: "memo-scoped-ok",
      ownerId: OWNER_ID,
      propertyId: PROPERTY_ID,
      body: MEMO_BODY,
      createdAt: new Date(),
      creator: null,
      property: { id: PROPERTY_ID, address: PROPERTY_ADDRESS },
    });

    const res = await POST(
      makeRequest({ body: MEMO_BODY, propertyId: PROPERTY_ID }),
      makeParams(),
    );
    expect(res.status).toBe(201);
    expect(pm._tx.ownerMemo.create).toHaveBeenCalledTimes(1);
  });

  it("field_staff + 自身が assignedTo の物件 → 成功", async () => {
    pm.property.findUnique.mockResolvedValue({
      id: PROPERTY_ID,
      isArchived: false,
      createdBy: "other-creator",
      assignedTo: "field-staff-1",
    });
    pm._tx.ownerMemo.create.mockResolvedValue({
      id: "memo-assigned-ok",
      ownerId: OWNER_ID,
      propertyId: PROPERTY_ID,
      body: MEMO_BODY,
      createdAt: new Date(),
      creator: null,
      property: { id: PROPERTY_ID, address: PROPERTY_ADDRESS },
    });

    const res = await POST(
      makeRequest({ body: MEMO_BODY, propertyId: PROPERTY_ID }),
      makeParams(),
    );
    expect(res.status).toBe(201);
  });

  it("field_staff + 担当外/作成者外の物件 → 403 / OwnerMemo.create 呼ばれない", async () => {
    pm.property.findUnique.mockResolvedValue({
      id: PROPERTY_ID,
      isArchived: false,
      createdBy: "other-creator",
      assignedTo: "other-assignee",
    });

    const res = await POST(
      makeRequest({ body: MEMO_BODY, propertyId: PROPERTY_ID }),
      makeParams(),
    );
    expect(res.status).toBe(403);
    // PropertyOwner link チェックも走らず、create も走らない
    expect(pm.propertyOwner.findFirst).not.toHaveBeenCalled();
    expect(pm._tx.ownerMemo.create).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
    // レスポンスに address が漏れない
    const text = await res.text();
    expect(text).not.toContain(PROPERTY_ADDRESS);
  });

  it("field_staff + propertyId=null（所有者単体メモ） → 従来どおり成功 / property scope は走らない", async () => {
    pm._tx.ownerMemo.create.mockResolvedValue({
      id: "memo-null",
      ownerId: OWNER_ID,
      propertyId: null,
      body: MEMO_BODY,
      createdAt: new Date(),
      creator: null,
      property: null,
    });

    const res = await POST(makeRequest({ body: MEMO_BODY }), makeParams());
    expect(res.status).toBe(201);
    expect(pm.property.findUnique).not.toHaveBeenCalled();
    expect(pm._tx.ownerMemo.create).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/owners/[id]/memos: field_staff レコードスコープ", () => {
  beforeEach(() => {
    vi.mocked(getApiSession).mockResolvedValue({
      id: "field-staff-1",
      email: "field@test.com",
      name: "Field",
      role: "field_staff",
    });
  });

  it("field_staff + 自身が createdBy → memo.property が返る", async () => {
    pm.ownerMemo.findMany.mockResolvedValue([
      {
        id: "memo-own",
        ownerId: OWNER_ID,
        propertyId: PROPERTY_ID,
        body: MEMO_BODY,
        createdAt: new Date(),
        creator: null,
        property: {
          id: PROPERTY_ID,
          address: PROPERTY_ADDRESS,
          createdBy: "field-staff-1",
          assignedTo: null,
        },
      },
    ]);

    const res = await GET(makeRequest({}, "GET"), makeParams());
    const json = await res.json();
    expect(json.memos[0].property).toEqual({
      id: PROPERTY_ID,
      address: PROPERTY_ADDRESS,
    });
  });

  it("field_staff + 担当外/作成者外 → propertyId は返るが property=null（address 漏れない）", async () => {
    pm.ownerMemo.findMany.mockResolvedValue([
      {
        id: "memo-out-of-scope",
        ownerId: OWNER_ID,
        propertyId: PROPERTY_ID,
        body: MEMO_BODY,
        createdAt: new Date(),
        creator: null,
        property: {
          id: PROPERTY_ID,
          address: PROPERTY_ADDRESS,
          createdBy: "other-creator",
          assignedTo: "other-assignee",
        },
      },
    ]);

    const res = await GET(makeRequest({}, "GET"), makeParams());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.memos[0].propertyId).toBe(PROPERTY_ID);
    expect(json.memos[0].property).toBeNull();
    // PII 漏れ防止: レスポンス全体に address が含まれない
    const text = JSON.stringify(json);
    expect(text).not.toContain(PROPERTY_ADDRESS);
  });

  it("field_staff: 自身が assignedTo のメモは property 返す、担当外のメモは property=null（混在）", async () => {
    pm.ownerMemo.findMany.mockResolvedValue([
      {
        id: "memo-assigned",
        ownerId: OWNER_ID,
        propertyId: PROPERTY_ID,
        body: MEMO_BODY,
        createdAt: new Date(),
        creator: null,
        property: {
          id: PROPERTY_ID,
          address: PROPERTY_ADDRESS,
          createdBy: "other",
          assignedTo: "field-staff-1",
        },
      },
      {
        id: "memo-out",
        ownerId: OWNER_ID,
        propertyId: "cccccccc-0000-4000-8000-000000000003",
        body: MEMO_BODY,
        createdAt: new Date(),
        creator: null,
        property: {
          id: "cccccccc-0000-4000-8000-000000000003",
          address: "別物件の住所",
          createdBy: "other",
          assignedTo: "other",
        },
      },
    ]);

    const res = await GET(makeRequest({}, "GET"), makeParams());
    const json = await res.json();
    expect(json.memos).toHaveLength(2);
    expect(json.memos[0].property).not.toBeNull();
    expect(json.memos[1].property).toBeNull();
    // 担当外メモの address はレスポンスに含まれない
    const text = JSON.stringify(json);
    expect(text).not.toContain("別物件の住所");
  });
});

// ── UI source assertion: OwnerMemoHistory が propertyId を送るパターン ──────
// テスト環境に React DOM がないため、source 文字列パターンで担保する。

import * as fs from "fs";
import * as path from "path";

describe("OwnerMemoHistory component: propertyId prop の送信パターン", () => {
  const file = path.resolve(
    process.cwd(),
    "src/components/owners/OwnerMemoHistory.tsx",
  );
  const src = fs.readFileSync(file, "utf8");

  it("propertyId prop を受け取る", () => {
    expect(src).toMatch(/propertyId\?\s*:\s*string/);
  });

  it("POST body の JSON.stringify に propertyId を spread で含める", () => {
    // propertyId が truthy なら { propertyId } を payload に含める形を要求
    expect(src).toMatch(/propertyId\s*\?\s*\{\s*propertyId\s*\}\s*:\s*\{\s*\}/);
  });

  it("メモ表示で関連物件リンクを `/properties/{id}` に向ける", () => {
    expect(src).toMatch(/\/properties\/\$\{m\.property\.id\}/);
  });
});

// ── property detail owner tab: OwnerMemoHistory に propertyId を渡す ─────────

describe("property detail owner tab: OwnerMemoHistory に propertyId を渡す", () => {
  it("OwnerMemoHistory 呼び出しに propertyId={propertyId} を含む", () => {
    const file = path.resolve(
      process.cwd(),
      "src/app/(dashboard)/properties/[id]/page.tsx",
    );
    const src = fs.readFileSync(file, "utf8");
    // OwnerMemoHistory ... propertyId={propertyId} を含むこと
    expect(src).toMatch(
      /<OwnerMemoHistory[\s\S]*?propertyId=\{propertyId\}[\s\S]*?\/>/,
    );
  });
});
