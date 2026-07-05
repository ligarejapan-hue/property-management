/**
 * recalculateJobCounts（groupBy 集約版）の単体テスト。
 *
 * import 行解決 / retry のたびに呼ばれる再集計を、全行 findMany ではなく
 * status 単位の groupBy で行う。挙動は従来実装と一致させる:
 *   - successCount       … success 行数
 *   - errorCount(保存値) … error + needs_review 行数
 *   - 未解決(error / needs_review / pending)が無ければ status="completed" / completedAt をセット
 * groupBy は該当 0 件の status を行として返さないため、0 埋めされることも検証する。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({
  default: {
    importJobRow: { groupBy: vi.fn() },
    importJob: { update: vi.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { recalculateJobCounts } from "../import-job-counts";

const pm = prisma as unknown as {
  importJobRow: { groupBy: Mock };
  importJob: { update: Mock };
};

const JOB_ID = "job-1";

beforeEach(() => {
  vi.clearAllMocks();
  pm.importJob.update.mockResolvedValue({});
});

describe("recalculateJobCounts (groupBy)", () => {
  it("status 単位の groupBy で jobId を絞って集計する", async () => {
    pm.importJobRow.groupBy.mockResolvedValue([
      { status: "success", _count: { _all: 1 } },
    ]);

    await recalculateJobCounts(JOB_ID);

    expect(pm.importJobRow.groupBy).toHaveBeenCalledTimes(1);
    expect(pm.importJobRow.groupBy).toHaveBeenCalledWith({
      by: ["status"],
      where: { jobId: JOB_ID },
      _count: { _all: true },
    });
  });

  it("全 success のとき successCount を集計し completed 化する", async () => {
    pm.importJobRow.groupBy.mockResolvedValue([
      { status: "success", _count: { _all: 3 } },
    ]);

    await recalculateJobCounts(JOB_ID);

    expect(pm.importJob.update).toHaveBeenCalledTimes(1);
    const arg = pm.importJob.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: JOB_ID });
    expect(arg.data.successCount).toBe(3);
    expect(arg.data.errorCount).toBe(0);
    expect(arg.data.status).toBe("completed");
    expect(arg.data.completedAt).toBeInstanceOf(Date);
  });

  it("error / needs_review が残るとき completed にせず errorCount を合算する", async () => {
    pm.importJobRow.groupBy.mockResolvedValue([
      { status: "success", _count: { _all: 2 } },
      { status: "error", _count: { _all: 1 } },
      { status: "needs_review", _count: { _all: 1 } },
    ]);

    await recalculateJobCounts(JOB_ID);

    const arg = pm.importJob.update.mock.calls[0][0];
    expect(arg.data.successCount).toBe(2);
    // errorCount(保存値) = error + needs_review
    expect(arg.data.errorCount).toBe(2);
    // 未解決があるので status / completedAt はセットしない
    expect(arg.data.status).toBeUndefined();
    expect(arg.data.completedAt).toBeUndefined();
  });

  it("needs_review のみでも未解決として completed にしない", async () => {
    pm.importJobRow.groupBy.mockResolvedValue([
      { status: "needs_review", _count: { _all: 5 } },
    ]);

    await recalculateJobCounts(JOB_ID);

    const arg = pm.importJob.update.mock.calls[0][0];
    expect(arg.data.successCount).toBe(0);
    expect(arg.data.errorCount).toBe(5);
    expect(arg.data.status).toBeUndefined();
    expect(arg.data.completedAt).toBeUndefined();
  });

  it("行が無い（groupBy が空配列）でも 0 埋めして completed 化する", async () => {
    pm.importJobRow.groupBy.mockResolvedValue([]);

    await recalculateJobCounts(JOB_ID);

    const arg = pm.importJob.update.mock.calls[0][0];
    expect(arg.data.successCount).toBe(0);
    expect(arg.data.errorCount).toBe(0);
    expect(arg.data.status).toBe("completed");
    expect(arg.data.completedAt).toBeInstanceOf(Date);
  });

  it("skipped は success/error どちらにも数えず、未解決でもないので completed 化する", async () => {
    pm.importJobRow.groupBy.mockResolvedValue([
      { status: "success", _count: { _all: 1 } },
      { status: "skipped", _count: { _all: 4 } },
    ]);

    await recalculateJobCounts(JOB_ID);

    const arg = pm.importJob.update.mock.calls[0][0];
    expect(arg.data.successCount).toBe(1);
    expect(arg.data.errorCount).toBe(0);
    expect(arg.data.status).toBe("completed");
    expect(arg.data.completedAt).toBeInstanceOf(Date);
  });

  it("error/needs_review が0でも pending 行が残っていれば completed にしない（手動添付ジョブの resume 待ち）", async () => {
    pm.importJobRow.groupBy.mockResolvedValue([
      { status: "success", _count: { _all: 2 } },
      { status: "pending", _count: { _all: 3 } },
    ]);

    await recalculateJobCounts(JOB_ID);

    const arg = pm.importJob.update.mock.calls[0][0];
    expect(arg.data.successCount).toBe(2);
    // pending は errorCount(保存値)には含めない（従来どおり error + needs_review のみ）
    expect(arg.data.errorCount).toBe(0);
    // pending が残っているので未解決 → completed 化しない
    expect(arg.data.status).toBeUndefined();
    expect(arg.data.completedAt).toBeUndefined();
  });
});
