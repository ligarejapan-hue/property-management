/**
 * GET /api/import/jobs/[jobId] の server-side summary 集約テスト（PR-A）。
 *
 * 詳細 route は rows 全件返却を維持しつつ、ImportJobRow の groupBy 2 本で
 * 5 区分サマリを **サーバ側で** 算出し、レスポンスに additive に付与する。
 * 検証内容:
 *   - レスポンスに summary が含まれ（6 項目）、rows など既存フィールドは維持（非破壊）
 *   - groupBy が where:{jobId} で 2 本（① status 別 / ②「更新」success）呼ばれる
 *   - createdCount = successTotal − updatedCount
 *   - groupBy が返さない status は 0 埋め
 *   - 出力が PR#98 の summaryFromStatusCounts() と同等
 *   - 存在しない jobId は 404
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
    importJob: { findUnique: vi.fn() },
    importJobRow: {
      groupBy: vi.fn(),
      // PR-B(B1): route が rows を findMany + count(母数/重複) で取得するようになったため、
      // PR-A の summary 検証でもこれらを mock しておく（既存アサーションは不変）。
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
    },
  },
}));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { GET } from "@/app/api/import/jobs/[jobId]/route";
import {
  summaryFromStatusCounts,
  type StatusCounts,
} from "@/lib/import-summary";

const pm = prisma as unknown as {
  importJob: { findUnique: Mock };
  importJobRow: {
    groupBy: Mock;
    findMany: Mock;
    findFirst: Mock;
    count: Mock;
  };
};

const JOB_ID = "job-1";

type StatusGroup = {
  status: "success" | "error" | "skipped" | "needs_review";
  _count: { _all: number };
};
type UpdatedGroup = { jobId: string; _count: { _all: number } };

function setup(
  job: unknown,
  statusGroups: StatusGroup[],
  updatedGroups: UpdatedGroup[],
) {
  pm.importJob.findUnique.mockResolvedValue(job);
  pm.importJobRow.groupBy.mockImplementation((args: { by: string[] }) =>
    Promise.resolve(args.by.includes("status") ? statusGroups : updatedGroups),
  );
  // rows は findMany 経由（route 改修後）。body.rows 検証用に job.rows を返す。
  pm.importJobRow.findMany.mockResolvedValue(
    (job as { rows?: unknown[] } | null)?.rows ?? [],
  );
  // count(母数/重複) は本スイートでは値を検証しないため 0 で十分。
  pm.importJobRow.count.mockResolvedValue(0);
  pm.importJobRow.findFirst.mockResolvedValue(null);
}

async function callGet(jobId = JOB_ID) {
  const req = new Request(`http://t/api/import/jobs/${jobId}`);
  const res = await GET(req as never, {
    params: Promise.resolve({ jobId }),
  });
  return { status: res.status, body: await res.json() };
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
});

describe("GET /api/import/jobs/[jobId] — server-side summary (PR-A)", () => {
  it("summary を additive に返し、rows など既存フィールドを維持する（非破壊）", async () => {
    setup(
      { id: JOB_ID, fileName: "f.csv", rows: [{ id: "r1" }, { id: "r2" }] },
      [
        { status: "success", _count: { _all: 5 } },
        { status: "skipped", _count: { _all: 2 } },
        { status: "error", _count: { _all: 1 } },
        { status: "needs_review", _count: { _all: 1 } },
      ],
      [{ jobId: JOB_ID, _count: { _all: 2 } }],
    );

    const { status, body } = await callGet();

    expect(status).toBe(200);
    // 既存フィールドは破壊しない
    expect(body.id).toBe(JOB_ID);
    expect(body.fileName).toBe("f.csv");
    expect(body.rows).toHaveLength(2);
    // summary が additive に付与される
    expect(body.summary).toEqual({
      createdCount: 3, // success 5 − updated 2
      updatedCount: 2,
      skippedCount: 2,
      needsReviewCount: 1,
      errorCount: 1,
      totalCount: 9,
    });
    expect(Object.keys(body.summary).sort()).toEqual(SUMMARY_KEYS);
  });

  it("groupBy を where:{jobId} で 2 本（status別 / 更新）呼ぶ", async () => {
    setup(
      { id: JOB_ID, rows: [] },
      [{ status: "success", _count: { _all: 1 } }],
      [],
    );

    await callGet();

    expect(pm.importJobRow.groupBy).toHaveBeenCalledTimes(2);
    const calls = pm.importJobRow.groupBy.mock.calls.map((c) => c[0]);
    const statusCall = calls.find((a) => a.by.includes("status"));
    const updatedCall = calls.find((a) => !a.by.includes("status"));

    // ① status 別件数（純粋に jobId で絞るのみ）
    expect(statusCall).toMatchObject({
      by: ["status"],
      where: { jobId: JOB_ID },
      _count: { _all: true },
    });
    expect(statusCall.where).not.toHaveProperty("status");
    expect(statusCall.where).not.toHaveProperty("errorMessage");

    // ②「更新」success 件数（isUpdateMessage 規約: success かつ errorMessage が「更新」始まり）
    expect(updatedCall).toMatchObject({
      by: ["jobId"],
      where: {
        jobId: JOB_ID,
        status: "success",
        errorMessage: { startsWith: "更新" },
      },
      _count: { _all: true },
    });
  });

  it("createdCount = successTotal − updatedCount かつ未返却 status は 0 埋め", async () => {
    setup(
      { id: JOB_ID, rows: [] },
      // success のみ（skipped / needs_review / error は groupBy が返さない）
      [{ status: "success", _count: { _all: 5 } }],
      [{ jobId: JOB_ID, _count: { _all: 2 } }],
    );

    const { body } = await callGet();

    expect(body.summary).toEqual({
      createdCount: 3, // 5 − 2
      updatedCount: 2,
      skippedCount: 0,
      needsReviewCount: 0,
      errorCount: 0,
      totalCount: 5,
    });
  });

  it("更新 groupBy が空（更新 0 件）のとき success は全て created 扱い", async () => {
    setup(
      { id: JOB_ID, rows: [] },
      [{ status: "success", _count: { _all: 4 } }],
      [], // 更新行なし
    );

    const { body } = await callGet();

    expect(body.summary.createdCount).toBe(4);
    expect(body.summary.updatedCount).toBe(0);
    expect(body.summary.totalCount).toBe(4);
  });

  it("出力は summaryFromStatusCounts() と同等（同じ集約値から一致）", async () => {
    const statusGroups: StatusGroup[] = [
      { status: "success", _count: { _all: 7 } },
      { status: "skipped", _count: { _all: 3 } },
      { status: "needs_review", _count: { _all: 2 } },
    ];
    const updatedGroups: UpdatedGroup[] = [
      { jobId: JOB_ID, _count: { _all: 4 } },
    ];
    setup({ id: JOB_ID, rows: [] }, statusGroups, updatedGroups);

    const { body } = await callGet();

    const expectedCounts: StatusCounts = {
      success: 7,
      skipped: 3,
      needs_review: 2,
    };
    expect(body.summary).toEqual(
      summaryFromStatusCounts(expectedCounts, 4),
    );
  });

  it("存在しない jobId は 404", async () => {
    setup(null, [], []);

    const { status, body } = await callGet("missing");

    expect(status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });
});
