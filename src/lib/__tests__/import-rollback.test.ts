import { describe, it, expect } from "vitest";
import { classifyRowsForRollback } from "../import-rollback";

describe("classifyRowsForRollback", () => {
  it("success + 新規作成（errorMessage が更新で始まらない） → delete", () => {
    const result = classifyRowsForRollback([
      {
        id: "r1",
        rowNumber: 1,
        status: "success",
        errorMessage: null,
        createdId: "p1",
      },
    ]);
    expect(result[0]).toMatchObject({ rowNumber: 1, createdId: "p1", category: "delete" });
  });

  it("success + 更新メッセージ → restore", () => {
    const result = classifyRowsForRollback([
      {
        id: "r2",
        rowNumber: 2,
        status: "success",
        errorMessage: "更新[realEstateNumber一致]: 既存物件ID=p2 (更新項目: address, note)",
        createdId: "p2",
      },
    ]);
    expect(result[0].category).toBe("restore");
  });

  it("status=error → skip", () => {
    const result = classifyRowsForRollback([
      {
        id: "r3",
        rowNumber: 3,
        status: "error",
        errorMessage: "住所が空です",
        createdId: null,
      },
    ]);
    expect(result[0].category).toBe("skip");
  });

  it("status=skipped → skip", () => {
    const result = classifyRowsForRollback([
      {
        id: "r4",
        rowNumber: 4,
        status: "skipped",
        errorMessage: null,
        createdId: null,
      },
    ]);
    expect(result[0].category).toBe("skip");
  });

  it("status=needs_review → skip", () => {
    const result = classifyRowsForRollback([
      {
        id: "r5",
        rowNumber: 5,
        status: "needs_review",
        errorMessage: "重複の可能性[住所一致]: 既存物件ID=p5",
        createdId: null,
      },
    ]);
    expect(result[0].category).toBe("skip");
  });

  it("success だが createdId なし → skip（防御的）", () => {
    const result = classifyRowsForRollback([
      {
        id: "r6",
        rowNumber: 6,
        status: "success",
        errorMessage: null,
        createdId: null,
      },
    ]);
    expect(result[0].category).toBe("skip");
  });

  it("複数行を一度に分類できる", () => {
    const result = classifyRowsForRollback([
      { id: "a", rowNumber: 1, status: "success", errorMessage: null, createdId: "p1" },
      { id: "b", rowNumber: 2, status: "success", errorMessage: "更新[一致]: x", createdId: "p2" },
      { id: "c", rowNumber: 3, status: "error", errorMessage: "x", createdId: null },
    ]);
    expect(result.map((r) => r.category)).toEqual(["delete", "restore", "skip"]);
  });
});
