/**
 * 月の上限(2026-10-29 発注者決定=5万円/月)の route 配線。
 *  - GET /api/registry-fetch/monthly-usage … 画面が「今月の有料取得 ◯円/50,000円」を出す材料
 *    (registry:auto_fetch + property:read・単発/一括と同じ門)
 *  - POST /api/registry-fetch/jobs … 上限に達していたら一括取得のジョブを作らせない(409)
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
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
    parseJsonBody: vi.fn(async (req: Request) => req.json()),
    apiResponse: vi.fn((data: unknown, status = 200) =>
      Response.json(data as object, { status }),
    ),
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
  };
});

vi.mock("@/lib/registry-fetch/bulk/route-support", () => ({
  requireBulkSession: vi.fn(),
  requireBulkPurchaseProvider: vi.fn(),
}));
vi.mock("@/lib/registry-fetch/bulk/jobs", () => ({
  createBulkFetchJob: vi.fn(),
}));
vi.mock("@/lib/registry-fetch/monthly-cap-store", () => ({
  getMonthlyPurchaseUsage: vi.fn(),
}));

import { ApiError } from "@/lib/api-helpers";
import {
  requireBulkSession,
  requireBulkPurchaseProvider,
} from "@/lib/registry-fetch/bulk/route-support";
import { createBulkFetchJob } from "@/lib/registry-fetch/bulk/jobs";
import { getMonthlyPurchaseUsage } from "@/lib/registry-fetch/monthly-cap-store";
import { POST as createJob } from "@/app/api/registry-fetch/jobs/route";
import * as usageRoute from "@/app/api/registry-fetch/monthly-usage/route";

const P1 = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

function usage(usedYen: number) {
  return {
    capYen: 50_000,
    spentYen: usedYen,
    pendingYen: 0,
    usedYen,
    prices: { owner: 140, all: 335 },
    resetsAt: "2026-11-30T15:00:00.000Z",
  };
}

function jobRequest(body: unknown) {
  return new Request("http://localhost/api/registry-fetch/jobs", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  }) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  (requireBulkSession as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (requireBulkPurchaseProvider as Mock).mockResolvedValue({});
  (createBulkFetchJob as Mock).mockResolvedValue({ jobId: "job-1" });
  (getMonthlyPurchaseUsage as Mock).mockResolvedValue(usage(0));
});

describe("GET /api/registry-fetch/monthly-usage", () => {
  it("GET だけを公開する", () => {
    expect(Object.keys(usageRoute).sort()).toEqual(["GET"]);
  });

  it("権限(registry:auto_fetch + property:read)の門を通してから利用額を返す", async () => {
    (getMonthlyPurchaseUsage as Mock).mockResolvedValue(usage(1400));
    const res = await usageRoute.GET();
    expect(res.status).toBe(200);
    expect(requireBulkSession).toHaveBeenCalledTimes(1);
    expect(await res.json()).toMatchObject({ capYen: 50_000, usedYen: 1400 });
  });

  it("門で弾かれたら(403)利用額を読まない", async () => {
    (requireBulkSession as Mock).mockRejectedValue(
      new ApiError(403, "権限がありません", "FORBIDDEN"),
    );
    const res = await usageRoute.GET();
    expect(res.status).toBe(403);
    expect(getMonthlyPurchaseUsage).not.toHaveBeenCalled();
  });
});

describe("POST /api/registry-fetch/jobs: 月の上限ならジョブを作らせない", () => {
  it("上限内なら作る", async () => {
    const res = await createJob(jobRequest({ confirmed: true, propertyIds: [P1] }));
    expect(res.status).toBe(201);
    expect(createBulkFetchJob).toHaveBeenCalledTimes(1);
  });

  it("⚠所有者事項がもう1通も入らないなら 409(月の上限)・ジョブを作らない", async () => {
    (getMonthlyPurchaseUsage as Mock).mockResolvedValue(usage(49_861));
    const res = await createJob(jobRequest({ confirmed: true, propertyIds: [P1] }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("REGISTRY_PURCHASE_MONTHLY_CAP_REACHED");
    expect(body.error.message).toContain("月の上限（5万円）に達したため");
    expect(createBulkFetchJob).not.toHaveBeenCalled();
  });

  it("種類の値段で見る(全部事項は残り140円では作らない・所有者事項は作れる)", async () => {
    (getMonthlyPurchaseUsage as Mock).mockResolvedValue(usage(49_860));
    const all = await createJob(
      jobRequest({ confirmed: true, propertyIds: [P1], certificateType: "all" }),
    );
    expect(all.status).toBe(409);
    const owner = await createJob(
      jobRequest({ confirmed: true, propertyIds: [P1], certificateType: "owner" }),
    );
    expect(owner.status).toBe(201);
  });

  it("⚠今月の額が読めなければ 503・作らない(数えられないまま始めない)", async () => {
    (getMonthlyPurchaseUsage as Mock).mockRejectedValue(new Error("db down"));
    const res = await createJob(jobRequest({ confirmed: true, propertyIds: [P1] }));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe(
      "REGISTRY_PURCHASE_MONTHLY_CAP_UNAVAILABLE",
    );
    expect(createBulkFetchJob).not.toHaveBeenCalled();
  });

  it("課金スイッチ休眠(501)が先=上限は読まない", async () => {
    (requireBulkPurchaseProvider as Mock).mockRejectedValue(
      new ApiError(501, "無効", "REGISTRY_PURCHASE_NOT_ENABLED"),
    );
    const res = await createJob(jobRequest({ confirmed: true, propertyIds: [P1] }));
    expect(res.status).toBe(501);
    expect(getMonthlyPurchaseUsage).not.toHaveBeenCalled();
  });
});
