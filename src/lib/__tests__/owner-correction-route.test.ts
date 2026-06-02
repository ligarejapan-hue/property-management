/**
 * POST /api/admin/owners/[id]/correction/address-fill route tests.
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
      propertyOwner: { findMany: vi.fn() },
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
import { POST } from "../../app/api/admin/owners/[id]/correction/address-fill/route";

// ── helpers ────────────────────────────────────────────────────────────────

const OWNER_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const JOB_ID = "bbbbbbbb-0000-0000-0000-000000000001";
const ROW_ID = "cccccccc-0000-0000-0000-000000000001";
const PROPERTY_ID = "dddddddd-0000-0000-0000-000000000001";
const RECEPTION_ROW_ID = "eeeeeeee-0000-0000-0000-000000000001";
const ADDRESS = "東京都千代田区1-1";
const OWNER_NAME = "田中太郎";
const OWNER_ZIP = "1000001";

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

const makeParams = () => ({ params: Promise.resolve({ id: OWNER_ID }) });

// prisma モックのキャスト
const pm = prisma as unknown as {
  owner: { findUnique: Mock };
  importJobRow: { findMany: Mock };
  propertyOwner: { findMany: Mock };
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

const ownerBase = {
  id: OWNER_ID,
  name: OWNER_NAME,
  address: null,
  zip: OWNER_ZIP,
  version: 1,
  isArchived: false,
};

// reception-owner row: createdId=propertyId、__owner_link_data あり
const receptionSuccessRow = {
  id: RECEPTION_ROW_ID,
  rowNumber: 1,
  status: "success",
  rawData: {
    ownerCount: "1",
    所有者CSV物件住所: ADDRESS,
    __owner_link_data: JSON.stringify([
      { name: OWNER_NAME, address: ADDRESS, zip: OWNER_ZIP },
    ]),
  },
  job: { id: JOB_ID, fileName: "reception.csv" },
};

function setupHappyPath() {
  pm.owner.findUnique.mockResolvedValue(ownerBase);
  pm.importJobRow.findMany.mockResolvedValue([successRow]);
  pm.propertyOwner.findMany.mockResolvedValue([]);
  pm.changeLog.findFirst.mockResolvedValue(null);
  // Phase 2-B: route が tx.owner.findUnique で現値（version + address）を取得して
  // 「実質空欄」検証 + race-safe な where 条件に使うため、tx の findUnique も
  // 用意する必要がある。
  pm._tx.owner.findUnique.mockResolvedValue({
    version: ownerBase.version,
    address: ownerBase.address,
  });
  pm._tx.owner.updateMany.mockResolvedValue({ count: 1 });
  pm._tx.changeLog.createMany.mockResolvedValue({ count: 1 });
}

function setupReceptionHappyPath() {
  pm.owner.findUnique.mockResolvedValue(ownerBase);
  // direct=0, then reception=1
  pm.importJobRow.findMany
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([receptionSuccessRow]);
  pm.propertyOwner.findMany.mockResolvedValue([{ propertyId: PROPERTY_ID }]);
  pm.changeLog.findFirst.mockResolvedValue(null);
  pm._tx.owner.findUnique.mockResolvedValue({
    version: ownerBase.version,
    address: ownerBase.address,
  });
  pm._tx.owner.updateMany.mockResolvedValue({ count: 1 });
  pm._tx.changeLog.createMany.mockResolvedValue({ count: 1 });
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("POST /api/admin/owners/[id]/correction/address-fill", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // デフォルト: 管理者権限フル（owner_address:full を含む）
    vi.mocked(getUserPermissions).mockResolvedValue([
      { resource: "user_management", action: "read", granted: true },
      { resource: "owner", action: "read", granted: true },
      { resource: "owner", action: "write", granted: true },
      { resource: "owner_address", action: "full", granted: true },
    ]);

    // propertyOwner はデフォルト空（direct 解決が成功するテストでは呼ばれない）
    pm.propertyOwner.findMany.mockResolvedValue([]);

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

  // ── owner_address フィールドレベル書込権 403 ──────────────────────────────

  const basePerms = [
    { resource: "user_management", action: "read", granted: true },
    { resource: "owner", action: "read", granted: true },
    { resource: "owner", action: "write", granted: true },
  ];

  it("owner_address:edit → 正常系が通る（edit は full と同等）", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue([
      ...basePerms,
      { resource: "owner_address", action: "edit", granted: true },
    ]);
    setupHappyPath();
    const res = await POST(makeRequest({ version: 1 }), makeParams());
    expect(res.status).toBe(201);
  });

  it("owner_address:masked → 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue([
      ...basePerms,
      { resource: "owner_address", action: "masked", granted: true },
    ]);
    const res = await POST(makeRequest({ version: 1 }), makeParams());
    expect(res.status).toBe(403);
  });

  it("owner_address:partial → 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue([
      ...basePerms,
      { resource: "owner_address", action: "partial", granted: true },
    ]);
    const res = await POST(makeRequest({ version: 1 }), makeParams());
    expect(res.status).toBe(403);
  });

  it("owner_address:hidden → 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue([
      ...basePerms,
      { resource: "owner_address", action: "hidden", granted: true },
    ]);
    const res = await POST(makeRequest({ version: 1 }), makeParams());
    expect(res.status).toBe(403);
  });

  it("owner_address:read のみ → 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue([
      ...basePerms,
      { resource: "owner_address", action: "read", granted: true },
    ]);
    const res = await POST(makeRequest({ version: 1 }), makeParams());
    expect(res.status).toBe(403);
  });

  it("owner_address 権限なし → 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(basePerms);
    const res = await POST(makeRequest({ version: 1 }), makeParams());
    expect(res.status).toBe(403);
  });

  it("owner_address 権限不足時は request.json が呼ばれず prisma/AuditLog に到達しない", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue([
      ...basePerms,
      { resource: "owner_address", action: "masked", granted: true },
    ]);
    // prisma は一切呼ばれないこと
    const res = await POST(makeRequest({ version: 1 }), makeParams());
    expect(res.status).toBe(403);
    expect(pm.owner.findUnique).not.toHaveBeenCalled();
    expect(pm.importJobRow.findMany).not.toHaveBeenCalled();
    expect(pm.$transaction).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
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

  it("ImportJobRow が複数件 → 422 (import_source_ambiguous)", async () => {
    pm.owner.findUnique.mockResolvedValue({
      id: OWNER_ID,
      address: null,
      version: 1,
      isArchived: false,
    });
    pm.importJobRow.findMany.mockResolvedValue([
      successRow,
      { ...successRow, id: "cccccccc-0000-0000-0000-000000000002", rowNumber: 2 },
    ]);
    pm.changeLog.findFirst.mockResolvedValue(null);

    const res = await POST(makeRequest({ version: 1 }), makeParams());
    expect(res.status).toBe(422);
    const j = await res.json();
    expect(j.error.code).toBe("ADDRESS_FILL_BLOCKED");
  });

  it("ImportJobRow が複数件かつ success があっても実行しない → 422", async () => {
    pm.owner.findUnique.mockResolvedValue({
      id: OWNER_ID,
      address: null,
      version: 1,
      isArchived: false,
    });
    pm.importJobRow.findMany.mockResolvedValue([
      successRow,
      { ...successRow, id: "cccccccc-0000-0000-0000-000000000003", rowNumber: 3, status: "needs_review" },
    ]);
    pm.changeLog.findFirst.mockResolvedValue(null);

    const res = await POST(makeRequest({ version: 1 }), makeParams());
    expect(res.status).toBe(422);
    // transaction が呼ばれていないこと
    expect(pm.$transaction).not.toHaveBeenCalled();
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

  // ── P2: reception-owner source 解決 ──────────────────────────────────────

  it("P2: direct 0件 + reception row 1件 + owner entry 一意一致 → 201", async () => {
    setupReceptionHappyPath();

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

  it("P2: reception-owner → AuditLog に住所値・rawData全文が入らず sourceType が正しい", async () => {
    setupReceptionHappyPath();

    await POST(makeRequest({ version: 1 }), makeParams());

    expect(writeAuditLog).toHaveBeenCalledOnce();
    const call = vi.mocked(writeAuditLog).mock.calls[0][0];
    // writeAuditLog の detail は unknown のため、参照前に検証用の形へ明示キャスト。
    const detail = call.detail as {
      sourceType: string;
      sourceFieldNames: string[];
      sourceRowId: string;
    };
    const detailStr = JSON.stringify(call.detail);
    // 住所値・rawData全文を含まないこと
    expect(detailStr).not.toContain(ADDRESS);
    expect(detailStr).not.toContain("rawData");
    // sourceType が reception_owner であること
    expect(detail.sourceType).toBe("reception_owner_import_job_row");
    // sourceFieldNames には値でなくフィールドパス名のみ
    expect(detail.sourceFieldNames).toEqual(["__owner_link_data.address"]);
    expect(detail.sourceRowId).toBe(RECEPTION_ROW_ID);
  });

  it("P2: reception row が複数 → 422 (import_source_ambiguous)", async () => {
    pm.owner.findUnique.mockResolvedValue(ownerBase);
    pm.importJobRow.findMany
      .mockResolvedValueOnce([])  // direct=0
      .mockResolvedValueOnce([   // reception 2件
        receptionSuccessRow,
        { ...receptionSuccessRow, id: "eeeeeeee-0000-0000-0000-000000000002", rowNumber: 2 },
      ]);
    pm.propertyOwner.findMany.mockResolvedValue([{ propertyId: PROPERTY_ID }]);
    pm.changeLog.findFirst.mockResolvedValue(null);

    const res = await POST(makeRequest({ version: 1 }), makeParams());
    expect(res.status).toBe(422);
    const j = await res.json();
    expect(j.error.code).toBe("ADDRESS_FILL_BLOCKED");
  });

  it("P2: reception row 1件だが owner entry が複数一致 → 422 (reception_owner_source_ambiguous)", async () => {
    pm.owner.findUnique.mockResolvedValue(ownerBase);
    pm.importJobRow.findMany
      .mockResolvedValueOnce([])  // direct=0
      .mockResolvedValueOnce([{  // reception 1件: __owner_link_data に同名2エントリ
        ...receptionSuccessRow,
        rawData: {
          ownerCount: "2",
          所有者CSV物件住所: ADDRESS,
          __owner_link_data: JSON.stringify([
            { name: OWNER_NAME, address: "東京都千代田区1-1", zip: null },
            { name: OWNER_NAME, address: "神奈川県横浜市2-2", zip: null },
          ]),
        },
      }]);
    pm.propertyOwner.findMany.mockResolvedValue([{ propertyId: PROPERTY_ID }]);
    pm.changeLog.findFirst.mockResolvedValue(null);

    const res = await POST(makeRequest({ version: 1 }), makeParams());
    expect(res.status).toBe(422);
    expect(pm.$transaction).not.toHaveBeenCalled();
  });

  it("P2: zip で絞り込み成功 → 201（同名2エントリも zip で一意化）", async () => {
    pm.owner.findUnique.mockResolvedValue(ownerBase); // OWNER_ZIP = "1000001"
    pm.importJobRow.findMany
      .mockResolvedValueOnce([])  // direct=0
      .mockResolvedValueOnce([{
        ...receptionSuccessRow,
        rawData: {
          ownerCount: "2",
          所有者CSV物件住所: ADDRESS,
          __owner_link_data: JSON.stringify([
            { name: OWNER_NAME, address: ADDRESS, zip: OWNER_ZIP },        // zip 一致
            { name: OWNER_NAME, address: "神奈川県横浜市2-2", zip: "2200001" }, // zip 不一致
          ]),
        },
      }]);
    pm.propertyOwner.findMany.mockResolvedValue([{ propertyId: PROPERTY_ID }]);
    pm.changeLog.findFirst.mockResolvedValue(null);
    pm._tx.owner.updateMany.mockResolvedValue({ count: 1 });
    pm._tx.changeLog.createMany.mockResolvedValue({ count: 1 });

    const res = await POST(makeRequest({ version: 1 }), makeParams());
    expect(res.status).toBe(201);
  });

  it("P2: 別ownerの住所は使わない（田中太郎のみ一致させる）", async () => {
    const OTHER_ADDRESS = "大阪府大阪市9-9";
    pm.owner.findUnique.mockResolvedValue(ownerBase);
    pm.importJobRow.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        ...receptionSuccessRow,
        rawData: {
          ownerCount: "2",
          所有者CSV物件住所: ADDRESS,
          __owner_link_data: JSON.stringify([
            { name: OWNER_NAME, address: ADDRESS, zip: OWNER_ZIP },
            { name: "佐藤花子", address: OTHER_ADDRESS, zip: null },
          ]),
        },
      }]);
    pm.propertyOwner.findMany.mockResolvedValue([{ propertyId: PROPERTY_ID }]);
    pm.changeLog.findFirst.mockResolvedValue(null);
    pm._tx.owner.updateMany.mockResolvedValue({ count: 1 });
    pm._tx.changeLog.createMany.mockResolvedValue({ count: 1 });

    const res = await POST(makeRequest({ version: 1 }), makeParams());
    expect(res.status).toBe(201);

    // AuditLog の sourceFieldNames に他owner の住所が含まれないこと
    const call = vi.mocked(writeAuditLog).mock.calls[0][0];
    expect(JSON.stringify(call.detail)).not.toContain(OTHER_ADDRESS);
  });

  it("P2: direct 0件 + reception 0件 → 422 (import_source_unknown)", async () => {
    pm.owner.findUnique.mockResolvedValue(ownerBase);
    pm.importJobRow.findMany
      .mockResolvedValueOnce([])   // direct=0
      .mockResolvedValueOnce([]);  // reception=0
    pm.propertyOwner.findMany.mockResolvedValue([{ propertyId: PROPERTY_ID }]);
    pm.changeLog.findFirst.mockResolvedValue(null);

    const res = await POST(makeRequest({ version: 1 }), makeParams());
    expect(res.status).toBe(422);
    const j = await res.json();
    expect(j.error.code).toBe("ADDRESS_FILL_BLOCKED");
  });

  // ── Phase 2-B: 空白のみ address 補完 / race-safe updateMany ────────────────

  it("Phase 2-B: 空白のみ address の owner も補完 execute 成功 (201)", async () => {
    // 上位 safety check 用の owner.address は空白のみ
    pm.owner.findUnique.mockResolvedValue({
      ...ownerBase,
      address: "   ", // 半角空白のみ
    });
    pm.importJobRow.findMany.mockResolvedValue([successRow]);
    pm.propertyOwner.findMany.mockResolvedValue([]);
    pm.changeLog.findFirst.mockResolvedValue(null);
    // tx 内 findUnique も同じ「空白のみ」を返す。route は isOwnerAddressEffectivelyEmpty
    // で空欄判定 + updateMany where: address=current.address で race-safe に補完する。
    pm._tx.owner.findUnique.mockResolvedValue({
      version: 1,
      address: "   ",
    });
    pm._tx.owner.updateMany.mockResolvedValue({ count: 1 });
    pm._tx.changeLog.createMany.mockResolvedValue({ count: 1 });

    const res = await POST(makeRequest({ version: 1 }), makeParams());
    expect(res.status).toBe(201);
    // updateMany が「address: current.address (= '   ')」の where で呼ばれている
    const calls = pm._tx.owner.updateMany.mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0][0].where).toMatchObject({
      id: OWNER_ID,
      version: 1,
      address: "   ",
    });
  });

  it("Phase 2-B: 全角空白のみ address の owner も補完 execute 成功", async () => {
    pm.owner.findUnique.mockResolvedValue({
      ...ownerBase,
      address: "　　",
    });
    pm.importJobRow.findMany.mockResolvedValue([successRow]);
    pm.propertyOwner.findMany.mockResolvedValue([]);
    pm.changeLog.findFirst.mockResolvedValue(null);
    pm._tx.owner.findUnique.mockResolvedValue({
      version: 1,
      address: "　　",
    });
    pm._tx.owner.updateMany.mockResolvedValue({ count: 1 });
    pm._tx.changeLog.createMany.mockResolvedValue({ count: 1 });

    const res = await POST(makeRequest({ version: 1 }), makeParams());
    expect(res.status).toBe(201);
    expect(pm._tx.owner.updateMany.mock.calls[0][0].where.address).toBe("　　");
  });

  it("Phase 2-B: tx 内 version 不一致 → 409 (CONFLICT) で updateMany を呼ばない", async () => {
    setupHappyPath();
    // tx 内 findUnique で version mismatch を返す
    pm._tx.owner.findUnique.mockResolvedValue({
      version: 2, // request version=1 と不一致
      address: null,
    });

    const res = await POST(makeRequest({ version: 1 }), makeParams());
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.error.code).toBe("CONFLICT");
    expect(pm._tx.owner.updateMany).not.toHaveBeenCalled();
  });

  it("Phase 2-B: tx 内 address が race で埋まっていた → 409 (ADDRESS_ALREADY_SET)", async () => {
    setupHappyPath();
    pm._tx.owner.findUnique.mockResolvedValue({
      version: 1,
      address: "他 tx が先に入れた値",
    });

    const res = await POST(makeRequest({ version: 1 }), makeParams());
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.error.code).toBe("ADDRESS_ALREADY_SET");
    expect(pm._tx.owner.updateMany).not.toHaveBeenCalled();
  });
});
