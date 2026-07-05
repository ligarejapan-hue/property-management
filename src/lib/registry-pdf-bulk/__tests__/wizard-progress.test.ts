import { describe, it, expect } from "vitest";
import { summarizeBulkJobProgress } from "../wizard-progress";

describe("summarizeBulkJobProgress", () => {
  it("処理中: done = total - pending", () => {
    const p = summarizeBulkJobProgress({
      totalRows: 10,
      pendingCount: 4,
      successCount: 5,
      errorCount: 1,
      status: "processing",
    });
    expect(p).toEqual({
      total: 10,
      done: 6,
      finished: false,
      label: "処理中 6/10件",
    });
  });

  it("完了: finished=true・statusで文言が変わる", () => {
    expect(
      summarizeBulkJobProgress({
        totalRows: 3,
        pendingCount: 0,
        successCount: 3,
        errorCount: 0,
        status: "completed",
      }),
    ).toEqual({ total: 3, done: 3, finished: true, label: "完了 3/3件" });
    expect(
      summarizeBulkJobProgress({
        totalRows: 3,
        pendingCount: 0,
        successCount: 1,
        errorCount: 2,
        status: "failed",
      }).label,
    ).toBe("完了(一部失敗) 3/3件");
  });

  it("null耐性: totalRows null は 0 扱い", () => {
    const p = summarizeBulkJobProgress({
      totalRows: null,
      successCount: null,
      errorCount: null,
      status: "pending",
    });
    expect(p.total).toBe(0);
    expect(p.finished).toBe(false);
  });
});
