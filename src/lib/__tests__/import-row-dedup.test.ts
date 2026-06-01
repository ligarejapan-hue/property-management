/**
 * Phase B: 手動 create_new / retry の owner 重複検出テスト。
 *
 * - PATCH /api/import/jobs/[jobId]/rows/[rowId] action=create_new
 * - POST  /api/import/jobs/[jobId]/rows/[rowId]/retry
 *
 * 既存 owner-csv 初期インポートと同じ優先順位（address+name 正規化、または name+phone 生値）。
 * 重複検出時は 409 DUPLICATE_OWNER で existingOwnerId のみ返し、PII は含めない。
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

vi.mock("@/lib/prisma", () => {
  return {
    default: {
      owner: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
      },
      property: {
        findUnique: vi.fn(),
        create: vi.fn(),
      },
      importJobRow: {
        findUnique: vi.fn(),
        groupBy: vi.fn(),
        update: vi.fn(),
      },
      importJob: {
        update: vi.fn(),
      },
    },
  };
});

import prisma from "@/lib/prisma";
import { PATCH } from "../../app/api/import/jobs/[jobId]/rows/[rowId]/route";
import { POST as RETRY } from "../../app/api/import/jobs/[jobId]/rows/[rowId]/retry/route";

const JOB_ID = "job-1";
const ROW_ID = "row-1";

const pm = prisma as unknown as {
  owner: {
    findUnique: Mock;
    findFirst: Mock;
    findMany: Mock;
    create: Mock;
  };
  property: { findUnique: Mock; create: Mock };
  importJobRow: { findUnique: Mock; groupBy: Mock; update: Mock };
  importJob: { update: Mock };
};

function makePatchRequest(body: unknown) {
  return new Request(
    `http://localhost/api/import/jobs/${JOB_ID}/rows/${ROW_ID}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  ) as unknown as import("next/server").NextRequest;
}

function makeRetryRequest(body: unknown) {
  return new Request(
    `http://localhost/api/import/jobs/${JOB_ID}/rows/${ROW_ID}/retry`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  ) as unknown as import("next/server").NextRequest;
}

const makeParams = () => ({
  params: Promise.resolve({ jobId: JOB_ID, rowId: ROW_ID }),
});

function ownerRow(rawData: Record<string, string>, status = "needs_review") {
  return {
    id: ROW_ID,
    jobId: JOB_ID,
    rowNumber: 2,
    status,
    rawData,
    job: { id: JOB_ID, jobType: "owner_csv" },
  };
}

function propertyRow(rawData: Record<string, string>, status = "needs_review") {
  return {
    id: ROW_ID,
    jobId: JOB_ID,
    rowNumber: 2,
    status,
    rawData,
    job: { id: JOB_ID, jobType: "property_csv" },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  pm.importJobRow.groupBy.mockResolvedValue([]); // recalculateJobCounts
  pm.importJob.update.mockResolvedValue({});
  pm.importJobRow.update.mockImplementation(({ data }: { data: unknown }) =>
    Promise.resolve({ id: ROW_ID, ...(data as object) }),
  );
});

// ---------- PATCH create_new ----------

describe("PATCH …/rows/[rowId] create_new owner_csv dedup", () => {
  it("normalizeName + normalizeAddress 一致で 409 DUPLICATE_OWNER", async () => {
    // CSV 行: 名前は半角スペース入り、住所は全角数字＋全角ハイフン。
    // 既存: 名前はスペースなし、住所は半角数字＋半角ハイフン。
    // normalizeName: 半角/全角スペース除去で同値、normalizeAddress: NFKC で全角数字・全角ハイフンを半角化。
    pm.importJobRow.findUnique.mockResolvedValue(
      ownerRow({ 氏名: "田中 太郎", 住所: "東京都千代田区１－１" }),
    );
    pm.owner.findMany.mockResolvedValue([
      { id: "owner-existing", name: "田中太郎", address: "東京都千代田区1-1" },
    ]);

    const res = await PATCH(
      makePatchRequest({ action: "create_new" }),
      makeParams(),
    );
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.code).toBe("DUPLICATE_OWNER");
    expect(body.error.existingOwnerId).toBe("owner-existing");
    expect(body.error.message).toBe("既存所有者候補が存在します");
    // PII（name / address / phone / rawData）が漏れていない
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("田中");
    expect(serialized).not.toContain("千代田");
    expect(pm.owner.create).not.toHaveBeenCalled();
  });

  it("name + phone 一致で 409 DUPLICATE_OWNER", async () => {
    pm.importJobRow.findUnique.mockResolvedValue(
      ownerRow({ 氏名: "佐藤花子", 電話番号: "090-1111-2222" }),
    );
    // address なしルートなので owner.findMany は呼ばれず、findFirst で phone 一致
    pm.owner.findFirst.mockResolvedValue({
      id: "owner-phone-match",
      name: "佐藤花子",
    });

    const res = await PATCH(
      makePatchRequest({ action: "create_new" }),
      makeParams(),
    );
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.code).toBe("DUPLICATE_OWNER");
    expect(body.error.existingOwnerId).toBe("owner-phone-match");
    expect(pm.owner.findFirst).toHaveBeenCalledWith({
      where: { name: "佐藤花子", phone: "090-1111-2222", isArchived: false },
      select: { id: true, name: true },
    });
    expect(pm.owner.create).not.toHaveBeenCalled();
  });

  it("重複なしで所有者作成", async () => {
    pm.importJobRow.findUnique.mockResolvedValue(
      ownerRow({ 氏名: "山田次郎", 住所: "東京都新宿区2-2" }),
    );
    pm.owner.findMany.mockResolvedValue([]); // 既存なし
    pm.owner.findFirst.mockResolvedValue(null);
    pm.owner.create.mockResolvedValue({ id: "owner-new" });

    const res = await PATCH(
      makePatchRequest({ action: "create_new" }),
      makeParams(),
    );

    expect(res.status).toBe(200);
    expect(pm.owner.create).toHaveBeenCalledTimes(1);
    expect(pm.importJobRow.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ROW_ID },
        data: expect.objectContaining({
          status: "success",
          createdId: "owner-new",
        }),
      }),
    );
  });

  it("property_csv create_new では dedup を実行しない", async () => {
    pm.importJobRow.findUnique.mockResolvedValue(
      propertyRow({ 住所: "東京都港区3-3" }),
    );
    pm.property.create.mockResolvedValue({ id: "prop-new" });

    const res = await PATCH(
      makePatchRequest({ action: "create_new" }),
      makeParams(),
    );

    expect(res.status).toBe(200);
    // owner 系の dedup 検索が一切走らない
    expect(pm.owner.findMany).not.toHaveBeenCalled();
    expect(pm.owner.findFirst).not.toHaveBeenCalled();
    expect(pm.owner.create).not.toHaveBeenCalled();
    expect(pm.property.create).toHaveBeenCalledTimes(1);
  });
});

// ---------- POST retry ----------

describe("POST …/rows/[rowId]/retry owner_csv dedup", () => {
  it("normalizeName + normalizeAddress 一致で 409 DUPLICATE_OWNER", async () => {
    pm.importJobRow.findUnique.mockResolvedValue(
      ownerRow(
        { 氏名: "鈴木 一郎", 住所: "大阪府大阪市北区１－１" },
        "error",
      ),
    );
    pm.owner.findMany.mockResolvedValue([
      { id: "owner-existing", name: "鈴木一郎", address: "大阪府大阪市北区1-1" },
    ]);

    const res = await RETRY(makeRetryRequest({}), makeParams());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.code).toBe("DUPLICATE_OWNER");
    expect(body.error.existingOwnerId).toBe("owner-existing");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("鈴木");
    expect(serialized).not.toContain("大阪");
    expect(pm.owner.create).not.toHaveBeenCalled();
    // 重複検出は state 変更を行わないため row.update は呼ばれない
    expect(pm.importJobRow.update).not.toHaveBeenCalled();
  });

  it("重複なしで所有者作成", async () => {
    pm.importJobRow.findUnique.mockResolvedValue(
      ownerRow({ 氏名: "高橋三郎", 住所: "福岡県福岡市中央区4-4" }, "error"),
    );
    pm.owner.findMany.mockResolvedValue([]);
    pm.owner.findFirst.mockResolvedValue(null);
    pm.owner.create.mockResolvedValue({ id: "owner-new" });

    const res = await RETRY(makeRetryRequest({}), makeParams());

    expect(res.status).toBe(200);
    expect(pm.owner.create).toHaveBeenCalledTimes(1);
    expect(pm.importJobRow.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "success",
          createdId: "owner-new",
        }),
      }),
    );
  });
});
