/**
 * 1件処理(processNextBulkItem)の中核分岐。単発の再利用・自動選択の抑制・課金安全を固定する。
 *  - 候補1つ → 単発取得を呼び done、attachmentId を項目へ
 *  - 候補が複数 → 単発取得を呼ばず skipped(ambiguous)
 *  - charged_but_failed → 項目 charged_but_failed + ジョブ paused
 *  - rate_limited → 項目を **pending へ戻す**(processing のまま取り残さない=再試行される)
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({
  default: {
    registryFetchJob: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    registryFetchJobItem: {
      findFirst: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));
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
  return { ApiError: MockApiError };
});
vi.mock("@/lib/registry-fetch/search", () => ({
  runRegistrySearch: vi.fn(),
  resolveRegistryCandidate: vi.fn(),
}));
vi.mock("@/lib/registry-fetch/auto-fetch", () => ({
  runRegistryAutoFetch: vi.fn(),
}));

import prisma from "@/lib/prisma";
import { runRegistrySearch, resolveRegistryCandidate } from "@/lib/registry-fetch/search";
import { runRegistryAutoFetch } from "@/lib/registry-fetch/auto-fetch";
import { RegistryFetchError } from "@/lib/registry-fetch";
import { processNextBulkItem } from "../process";

const pm = prisma as unknown as {
  registryFetchJob: { findUnique: Mock; updateMany: Mock; update: Mock };
  registryFetchJobItem: { findFirst: Mock; update: Mock; count: Mock };
  $transaction: Mock;
};

const provider = {} as never;
const SESSION = { id: "u1", role: "field_staff" };

beforeEach(() => {
  vi.clearAllMocks();
  // job0 と finalize の jobNow の両方に使う基本形。
  pm.registryFetchJob.findUnique.mockResolvedValue({
    id: "job-1",
    requestedById: "u1",
    status: "processing",
    certificateType: "owner",
    startedAt: new Date("2026-08-07T00:00:00Z"),
    activeItemId: null,
  });
  pm.registryFetchJob.updateMany.mockResolvedValue({ count: 1 }); // 掴み成功
  pm.registryFetchJob.update.mockResolvedValue({});
  pm.registryFetchJobItem.findFirst.mockResolvedValue({
    id: "item-1",
    property: { id: "p1", createdBy: "u1", assignedTo: null },
  });
  pm.registryFetchJobItem.update.mockResolvedValue({});
  pm.registryFetchJobItem.count.mockResolvedValue(0); // 以後 pending なし
  pm.$transaction.mockImplementation((arg: unknown) => {
    if (typeof arg === "function") return (arg as (tx: typeof prisma) => unknown)(prisma);
    if (Array.isArray(arg)) return Promise.all(arg);
    return Promise.resolve();
  });
  (resolveRegistryCandidate as Mock).mockResolvedValue({
    candidate: { kind: "location", lotNumber: "1", buildingNumber: null },
    fingerprint: "fp",
  });
});

/** finalize で項目に確定した status を取り出す(update 呼び出しのうち終了状態を書いたもの)。 */
function finalizedItemData(): Record<string, unknown> | undefined {
  const calls = pm.registryFetchJobItem.update.mock.calls;
  // 最後の update が finalize(status を done/skipped/pending 等へ)。
  return calls.length ? (calls[calls.length - 1][0].data as Record<string, unknown>) : undefined;
}

describe("processNextBulkItem", () => {
  it("候補1つ → 単発取得を呼び done(attachmentId を項目へ)", async () => {
    (runRegistrySearch as Mock).mockResolvedValue({
      searchable: true,
      candidates: [{ candidateRef: "r1" }],
    });
    (runRegistryAutoFetch as Mock).mockResolvedValue({ attachmentId: "att-1", status: "success" });

    const res = await processNextBulkItem({ session: SESSION, jobId: "job-1", provider });

    expect(runRegistryAutoFetch).toHaveBeenCalledTimes(1);
    // 種別はジョブ値(owner)が単発へ渡る。
    expect((runRegistryAutoFetch as Mock).mock.calls[0][0]).toMatchObject({
      certificateType: "owner",
      locationCandidate: { lotNumber: "1", buildingNumber: null },
    });
    expect(res.outcome).toBe("processed");
    expect(res.itemStatus).toBe("done");
    expect(finalizedItemData()).toMatchObject({ status: "done", attachmentId: "att-1" });
  });

  it("候補が複数 → 単発取得を呼ばず skipped(ambiguous)", async () => {
    (runRegistrySearch as Mock).mockResolvedValue({
      searchable: true,
      candidates: [{ candidateRef: "r1" }, { candidateRef: "r2" }],
    });

    const res = await processNextBulkItem({ session: SESSION, jobId: "job-1", provider });

    expect(runRegistryAutoFetch).not.toHaveBeenCalled();
    expect(res.itemStatus).toBe("skipped");
    expect(finalizedItemData()).toMatchObject({ status: "skipped", errorCode: "ambiguous_candidate" });
  });

  it("charged_but_failed → 項目 charged_but_failed + ジョブ paused", async () => {
    (runRegistrySearch as Mock).mockResolvedValue({
      searchable: true,
      candidates: [{ candidateRef: "r1" }],
    });
    (runRegistryAutoFetch as Mock).mockRejectedValue(new RegistryFetchError("charged_but_failed"));

    const res = await processNextBulkItem({ session: SESSION, jobId: "job-1", provider });

    expect(res.jobStatus).toBe("paused");
    expect(finalizedItemData()).toMatchObject({ status: "charged_but_failed" });
    // ジョブ更新のどこかで paused に落としている。
    const jobStatuses = pm.registryFetchJob.update.mock.calls.map(
      (c) => (c[0].data as { status?: string }).status,
    );
    expect(jobStatuses).toContain("paused");
  });

  it("rate_limited → 項目を pending へ戻す(processing のまま取り残さない)", async () => {
    (runRegistrySearch as Mock).mockResolvedValue({
      searchable: true,
      candidates: [{ candidateRef: "r1" }],
    });
    (runRegistryAutoFetch as Mock).mockRejectedValue(new RegistryFetchError("rate_limited"));

    const res = await processNextBulkItem({ session: SESSION, jobId: "job-1", provider });

    expect(res.outcome).toBe("rate_limited");
    expect(finalizedItemData()).toMatchObject({ status: "pending" });
  });

  it("掴み失敗(他が実行中) → busy", async () => {
    pm.registryFetchJob.updateMany.mockResolvedValue({ count: 0 });
    const res = await processNextBulkItem({ session: SESSION, jobId: "job-1", provider });
    expect(res.outcome).toBe("busy");
    expect(runRegistrySearch).not.toHaveBeenCalled();
  });

  it("作成者以外 → 403", async () => {
    await expect(
      processNextBulkItem({ session: { id: "u2", role: "field_staff" }, jobId: "job-1", provider }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
