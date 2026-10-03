import { describe, it, expect } from "vitest";
import { planConfirmLogs } from "../confirm-plan";

describe("確定で送付記録を作る/再利用する", () => {
  it("logId が無い行は作る・あり(残っている)行は再利用", () => {
    expect(
      planConfirmLogs([
        { id: "a", logId: null, logExists: false },
        { id: "b", logId: "L1", logExists: true },
      ]),
    ).toEqual({ reuse: [{ itemId: "b", logId: "L1" }], create: ["a"] });
  });

  it("logId が指す記録が消えていたら作り直す(物件削除で記録ごと消えた場合)", () => {
    expect(planConfirmLogs([{ id: "a", logId: "L9", logExists: false }])).toEqual({ reuse: [], create: ["a"] });
  });

  it("並びは入力順を保つ", () => {
    const r = planConfirmLogs([
      { id: "c", logId: null, logExists: false },
      { id: "a", logId: null, logExists: false },
    ]);
    expect(r.create).toEqual(["c", "a"]);
  });
});
