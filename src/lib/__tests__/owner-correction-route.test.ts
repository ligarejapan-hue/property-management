/**
 * POST /api/admin/owners/[ownerId]/correction/address-fill route tests.
 *
 * next/server および @/lib/api-helpers（→ next-auth）を完全モックして
 * DB 接続・Next.js ランタイムなしでルートハンドラを単体テストする。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// ── モック設定（vi.mock はファイル先頭にホイスト） ─────────────────────────

vi.mock("next/server", () => {
  class MockNextRequest extends Request {
    constructor(input: string | URL | Request, init?: RequestInit) {
      super(input, init);
    }
  }
  return { NextRequest: MockNextRequest };
});

// ApiError は route 内と handleApiError の両方で同じクラス参照が必要なため、
// importOriginal を使わずに自前実装を提供する。
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
      { resource: "user_management", action: "read", granted: true },
      { resource: "owner", action: "read", granted: true },
      { resource: "owner", action: "write", granted: true },
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

vi.mock("@/lib/prisma", () => {
  const tx = {
    owner: { updateMany: vi.fn(), findUnique: vi.fn() },
    changeLog: { createMany: vi.fn() },
  };
  return {
    default: {
      owner: { findUnique: vi.fn() },
      importJobRow: { findMany: vi.fn() },
      changeLog: { findFirst: vi.fn() },
      $transaction: vi
        .fn()
        .mockImplementation((fn: (tx: unknown) => unknown) => fn(tx)),
      _tx: tx,
    },
  };
});

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

// ── import（モック登録後） ──────────────────────────────────────────────────

import prisma from "@/lib/prisma";
import { getUserPermissions } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { POST } from "../../app/api/admin/owners/[ownerId]/correction/address-fill/route";

// ── helpers ────────────────────────────────────────────────────────────────

const OWNER_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const JOB_ID = "bbbbbbbb-0000-0000-0000-000000000001";
const ROW_ID = "cccccccc-0000-0000-0000-000000000001";
const ADDRESS = "東京都千代田区1-1";

function makeRequest(body: unknown) {
  return new Request(
    `http://localhost/api/admin/owners/${OWNER_ID}/correction/address-fill`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  ) as unknown as import("next/server").NextRequest;
}

const makeParams = () => ({ params: Promise.resolve({ ownerId: OWNER_ID }) });

// prisma モックのキャスト
const pm = prisma as unknown as {
  owner: { findUnique: Mock };
  importJobRow: { findMany: Mock };
  changeLog: { findFirst: Mock };
  $transaction: Mock;
  _tx: {
    owner: { updateMany: Mock; findUnique: Mock };
    changeLog: { createMany: Mock };
  };
};

const successRow = {
  id: ROW_ID,
  rowNumber: 1,
  status: "success",
  rawData: { 住所: ADDRESS },
  job: { id: JOB_ID, fileName: "owners.csv" },
};

function setupHappyPath() {
  pm.owner.findUnique.mockResolvedValue({
    id: OWNER_ID,
    address: null,
    version: 1,
    isArchived: false,
  });
  pm.importJobRow.findMany.mockResolvedValue([successRow]);
  pm.changeLog.findFirst.mockResolvedValue(null);
  pm._tx.owner.updateMany.mockResolvedValue({ count: 1 });
  pm._tx.changeLog.createMany.mockResolvedValue({ count: 1 });
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("POST /api/admin/owners/[ownerId]/correction/address-fill", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // デフォルト: 管理者権限フル
    vi.mocked(getUserPermissions).mockResolvedValue([
      { resource: "user_management", action: "read", granted: true },
      { resource: "owner", action: "read", granted: true },
      { resource: "owner", action: "write", granted: true },
    ]);

    // $transaction はデフォルトで _tx コールバックを実行
    pm.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(pm._tx),
    );
  });

  // ── 正常系 ────────────────────────────────────────────────────────────────

  it("正常系: 201 を返し住所値をレスポンスに含めない", async () => {
    setupHappyPath();

    const res = await POST(makeRequest({ version: 1 }), makeParams());
    expect(res.status).toBe(201);

    const json = await res.json();
    expect(json).toMatchObject({
      id: OWNER_ID,
      version: 2,
      updatedFields: ["address"],
    });
    // レスポンスに住所値が含まれないこと
    expect(JSON.stringify(json)).not.toContain(ADDRESS);
  });

  it("正常系: AuditLog に住所値・rawData全文が入らない", async () => {
    setupHappyPath();

    await POST(makeRequest({ version: 1 }), makeParams());

    expect(writeAuditLog).toHaveBeenCalledOnce();
    const call = vi.mocked(writeAuditLog).mock.calls[0][0];
    expect(call.action).toBe("owner_correction_address_fill");
    expect(call.targetId).toBe(OWNER_ID);

    const detailStr = JSON.stringify(call.detail);
    // 住所値・rawData全文を含まないこと
    expect(detailStr).not.toContain(ADDRESS);
    expect(detailStr).not.toContain("rawData");

    // 必要な識別情報は含むこと
    expect(call.detail).toMatchObject({
      correctionType: "address_fill",
      sourceType: "import_job_row",
      sourceRowId: ROW_ID,
      sourceJobId: JOB_ID,
      updatedFields: ["address"],
      sourceFieldNames: ["住所"],
    });
  });

  // ── 権限不足 403 ──────────────────────────────────────────────────────────

  it("user_management:read なし → 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue([
      { resource: "owner", action: "read", granted: true },
      { resource: "owner", action: "write", granted: true },
    ]);
    const res = await POST(makeRequest({ version: 1 }), makeParams());
    expect(res.status).toBe(403);
  });

  it("owner:read なし → 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue([
      { resource: "user_management", action: "read", granted: true },
      { resource: "owner", action: "write", granted: true },
    ]);
    const res = await POST(makeRequest({ version: 1 }), makeParams());
    expect(res.status).toBe(403);
  });

  it("owner:write なし → 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue([
      { resource: "user_management", action: "read", granted: true },
      { resource: "owner", action: "read", granted: true },
    ]);
    const res = await POST(makeRequest({ version: 1 }), makeParams());
    expect(res.status).toBe(403);
  });

  // ── 入力不正 400 ──────────────────────────────────────────────────────────

  it("version が文字列 → 400", async () => {
    const res = await POST(makeRequest({ version: "1" }), makeParams());
    expect(res.status).toBe(400);
  });

  it("version が 0 → 400", async () => {
    const res = await POST(makeRequest({ version: 0 }), makeParams());
    expect(res.status).toBe(400);
  });

  // ── 404 ──────────────────────────────────────────────────────────────────

  it("Owner not found → 404", async () => {
    pm.owner.findUnique.mockResolvedValue(null);
    const res = await POST(makeRequest({ version: 1 }), makeParams());
    expect(res.status).toBe(404);
  });

  it("Owner が isArchived → 404", async () => {
    pm.owner.findUnique.mockResolvedValue({
      id: OWNER_ID,
      address: null,
      version: 1,
      isArchived: true,
    });
    const res = await POST(makeRequest({ version: 1 }), makeParams());
    expect(res.status).toBe(404);
  });

  // ── 422 安全条件違反 ──────────────────────────────────────────────────────

  it("ImportJobRow なし → 422 (import_source_unknown)", async () => {
    pm.owner.findUnique.mockResolvedValue({
      id: OWNER_ID,
      address: null,
      version: 1,
      isArchived: false,
    });
    pm.importJobRow.findMany.mockResolvedValue([]);
    pm.changeLog.findFirst.mockResolvedValue(null);

    const res = await POST(makeRequest({ version: 1 }), makeParams());
    expect(res.status).toBe(422);
    const j = await res.json();
    expect(j.error.code).toBe("ADDRESS_FILL_BLOCKED");
  });

  it("ImportJobRow.status が success でない → 422 (import_row_not_success)", async () => {
    pm.owner.findUnique.mockResolvedValue({
      id: OWNER_ID,
      address: null,
      version: 1,
      isArchived: false,
    });
    pm.importJobRow.findMany.mockResolvedValue([
      { ...successRow, status: "needs_review" },
    ]);
    pm.changeLog.findFirst.mockResolvedValue(null);

    const res = await POST(makeRequest({ version: 1 }), makeParams());
    expect(res.status).toBe(422);
  });

  it("rawData から住所を抽出できない → 422 (no_address_in_rawdata)", async () => {
    pm.owner.findUnique.mockResolvedValue({
      id: OWNER_ID,
      address: null,
      version: 1,
      isArchived: false,
    });
    pm.importJobRow.findMany.mockResolvedValue([
      { ...successRow, rawData: { 氏名: "田中太郎" } },
    ]);
    pm.changeLog.findFirst.mockResolvedValue(null);

    const res = await POST(makeRequest({ version: 1 }), makeParams());
    expect(res.status).toBe(422);
  });

  it("address フィールドの ChangeLog が存在 → 422 (address_changelog_exists)", async () => {
    pm.owner.findUnique.mockResolvedValue({
      id: OWNER_ID,
      address: null,
      version: 1,
      isArchived: false,
    });
    pm.importJobRow.findMany.mockResolvedValue([successRow]);
    pm.changeLog.findFirst.mockResolvedValue({ id: "cl-1" });

    const res = await POST(makeRequest({ version: 1 }), makeParams());
    expect(res.status).toBe(422);
  });

  // ── 409 ──────────────────────────────────────────────────────────────────

  it("安全条件: address が既に設定済み → 409", async () => {
    pm.owner.findUnique.mockResolvedValue({
      id: OWNER_ID,
      address: "既存の住所",
      version: 1,
      isArchived: false,
    });
    pm.importJobRow.findMany.mockResolvedValue([successRow]);
    pm.changeLog.findFirst.mockResolvedValue(null);

    const res = await POST(makeRequest({ version: 1 }), makeParams());
    expect(res.status).toBe(409);
  });

  it("transaction: updateMany count=0 かつ address が空 → 409 (CONFLICT)", async () => {
    setupHappyPath();
    pm.$transaction.mockImplementationOnce((fn: (tx: unknown) => unknown) =>
      fn({
        owner: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          findUnique: vi
            .fn()
            .mockResolvedValue({ version: 2, address: null }),
        },
        changeLog: { createMany: vi.fn() },
      }),
    );

    const res = await POST(makeRequest({ version: 1 }), makeParams());
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.error.code).toBe("CONFLICT");
  });

  it("transaction: updateMany count=0 かつ address が入っている → 409 (ADDRESS_ALREADY_SET)", async () => {
    setupHappyPath();
    pm.$transaction.mockImplementationOnce((fn: (tx: unknown) => unknown) =>
      fn({
        owner: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          findUnique: vi.fn().mockResolvedValue({
            version: 1,
            address: "他の操作で設定済み",
          }),
        },
        changeLog: { createMany: vi.fn() },
      }),
    );

    const res = await POST(makeRequest({ version: 1 }), makeParams());
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.error.code).toBe("ADDRESS_ALREADY_SET");
  });
});
