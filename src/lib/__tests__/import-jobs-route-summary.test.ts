/**
 * GET /api/import/jobs の一覧サマリ集約テスト。
 *
 * 一覧 route は ImportJobRow 全行取得 + JS 集計を廃し、Prisma groupBy 2 本
 * （① jobId×status 件数 / ② jobId ごとの「更新」success 件数）で各 job の
 * 5 区分サマリを組む。本テストはその集約挙動を検証する:
 *   - groupBy が 2 本、正しい by / where で呼ばれる
 *   - createdCount = successTotal − updatedCount
 *   - groupBy が返さない status は 0 埋め
 *   - 複数 job が jobId 別に振り分けられる
 *   - 現ページに job が無いときは groupBy を打たない（空 in 回避）
 *   - レスポンスの summary 形状が既存（ImportSummary の6項目）と一致
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

vi.mock("@/lib/permissions", () => ({
  hasPermission: vi.fn(() => true),
}));

vi.mock("@/lib/prisma", () => ({
  default: {
    importJob: { count: vi.fn(), findMany: vi.fn() },
    importJobRow: { groupBy: vi.fn() },
    auditLog: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { GET } from "@/app/api/import/jobs/route";

const pm = prisma as unknown as {
  importJob: { count: Mock; findMany: Mock };
  importJobRow: { groupBy: Mock };
  auditLog: { findMany: Mock };
  $transaction: Mock;
};

type StatusGroup = {
  jobId: string;
  status: "success" | "error" | "skipped" | "needs_review";
  _count: { _all: number };
};
type UpdatedGroup = { jobId: string; _count: { _all: number } };

function setup(
  jobs: { id: string }[],
  statusGroups: StatusGroup[],
  updatedGroups: UpdatedGroup[],
) {
  pm.importJob.count.mockResolvedValue(jobs.length);
  pm.importJob.findMany.mockResolvedValue(jobs);
  pm.importJobRow.groupBy.mockImplementation((args: { by: string[] }) =>
    Promise.resolve(args.by.includes("status") ? statusGroups : updatedGroups),
  );
}

async function callGet(query = "") {
  const req = new Request(`http://t/api/import/jobs${query}`);
  const res = await GET(req as never);
  return (await res.json()) as {
    data: Array<{ id: string; summary: Record<string, number> }>;
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
  };
}

const SUMMARY_KEYS = [
  "createdCount",
  "errorCount",
  "needsReviewCount",
  "skippedCount",
  "totalCount",
  "updatedCount",
];

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({
    id: "u1",
    email: "a@b",
    name: "A",
    role: "admin",
  });
  (getUserPermissions as Mock).mockResolvedValue([
    { resource: "import", action: "write", granted: true },
  ]);
  (hasPermission as Mock).mockReturnValue(true);
  pm.auditLog.findMany.mockResolvedValue([]);
  pm.$transaction.mockImplementation((ops: Promise<unknown>[]) =>
    Promise.all(ops),
  );
});

describe("GET /api/import/jobs — groupBy サマリ集約", () => {
  it("現ページに job が無いとき groupBy を打たず data は空", async () => {
    setup([], [], []);

    const body = await callGet();

    expect(pm.importJobRow.groupBy).not.toHaveBeenCalled();
    expect(body.data).toEqual([]);
    expect(body.pagination.total).toBe(0);
  });

  it("groupBy を 2 本（status別 / 更新件数）正しい by・where で呼ぶ", async () => {
    setup(
      [{ id: "job-1" }],
      [
        { jobId: "job-1", status: "success", _count: { _all: 5 } },
        { jobId: "job-1", status: "skipped", _count: { _all: 2 } },
        { jobId: "job-1", status: "error", _count: { _all: 1 } },
        { jobId: "job-1", status: "needs_review", _count: { _all: 1 } },
      ],
      [{ jobId: "job-1", _count: { _all: 2 } }],
    );

    await callGet();

    expect(pm.importJobRow.groupBy).toHaveBeenCalledTimes(2);

    const calls = pm.importJobRow.groupBy.mock.calls.map((c) => c[0]);
    const statusCall = calls.find((a) => a.by.includes("status"));
    const updatedCall = calls.find((a) => !a.by.includes("status"));

    // ① status 別件数
    expect(statusCall).toMatchObject({
      by: ["jobId", "status"],
      where: { jobId: { in: ["job-1"] } },
      _count: { _all: true },
    });
    // success フィルタや更新フィルタを混ぜていない（純粋な status 別件数）
    expect(statusCall.where).not.toHaveProperty("status");
    expect(statusCall.where).not.toHaveProperty("errorMessage");

    // ② 更新件数（success かつ errorMessage が「更新」始まり = isUpdateMessage 規約）
    expect(updatedCall).toMatchObject({
      by: ["jobId"],
      where: {
        jobId: { in: ["job-1"] },
        status: "success",
        errorMessage: { startsWith: "更新" },
      },
      _count: { _all: true },
    });
  });

  it("createdCount = successTotal − updatedCount、未返却 status は 0 埋め", async () => {
    setup(
      [{ id: "job-1" }],
      // success のみ（skipped / needs_review / error は groupBy が返さない）
      [{ jobId: "job-1", status: "success", _count: { _all: 5 } }],
      [{ jobId: "job-1", _count: { _all: 2 } }],
    );

    const body = await callGet();

    expect(body.data[0].summary).toEqual({
      createdCount: 3, // 5 - 2
      updatedCount: 2,
      skippedCount: 0,
      needsReviewCount: 0,
      errorCount: 0,
      totalCount: 5,
    });
  });

  it("複数 job を jobId 別に振り分け、更新 groupBy に無い job は更新 0", async () => {
    setup(
      [{ id: "job-1" }, { id: "job-2" }],
      [
        { jobId: "job-1", status: "success", _count: { _all: 2 } },
        { jobId: "job-1", status: "error", _count: { _all: 1 } },
        { jobId: "job-2", status: "skipped", _count: { _all: 3 } },
      ],
      // job-2 は更新 groupBy に現れない → updatedCount 0 扱い
      [{ jobId: "job-1", _count: { _all: 1 } }],
    );

    const body = await callGet();
    const byId = Object.fromEntries(body.data.map((d) => [d.id, d.summary]));

    expect(byId["job-1"]).toEqual({
      createdCount: 1, // success 2 - updated 1
      updatedCount: 1,
      skippedCount: 0,
      needsReviewCount: 0,
      errorCount: 1,
      totalCount: 3,
    });
    expect(byId["job-2"]).toEqual({
      createdCount: 0,
      updatedCount: 0,
      skippedCount: 3,
      needsReviewCount: 0,
      errorCount: 0,
      totalCount: 3,
    });
  });

  it("summary の形状（キー集合）が ImportSummary の6項目と一致する", async () => {
    setup(
      [{ id: "job-1" }],
      [{ jobId: "job-1", status: "success", _count: { _all: 1 } }],
      [],
    );

    const body = await callGet();

    expect(Object.keys(body.data[0].summary).sort()).toEqual(SUMMARY_KEYS);
    // トップレベルのレスポンス形状（data + pagination）も既存と一致
    expect(body).toHaveProperty("data");
    expect(Object.keys(body.pagination).sort()).toEqual([
      "limit",
      "page",
      "total",
      "totalPages",
    ]);
  });
});
