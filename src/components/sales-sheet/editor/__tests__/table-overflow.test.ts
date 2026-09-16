import { describe, it, expect } from "vitest";
import { overflowingTableIds } from "../table-overflow";

describe("overflowingTableIds", () => {
  it("ぴったり収まっていれば入りきっていない表なし", () => {
    expect(overflowingTableIds([{ id: "a", scrollHeight: 100, clientHeight: 100 }])).toEqual([]);
  });

  it("既定の許容誤差(1px)以内のはみ出しは無視する", () => {
    expect(overflowingTableIds([{ id: "a", scrollHeight: 101, clientHeight: 100 }])).toEqual([]);
  });

  it("許容誤差を超えるはみ出しは id を返す", () => {
    expect(overflowingTableIds([{ id: "a", scrollHeight: 102, clientHeight: 100 }])).toEqual(["a"]);
  });

  it("複数 id は入力の順番を保つ", () => {
    const boxes = [
      { id: "overview", scrollHeight: 50, clientHeight: 40 },
      { id: "overview-detail-a", scrollHeight: 30, clientHeight: 30 },
      { id: "overview-detail-b", scrollHeight: 20, clientHeight: 10 },
    ];
    expect(overflowingTableIds(boxes)).toEqual(["overview", "overview-detail-b"]);
  });

  it("同じ id の重複は1回だけ報告する", () => {
    const boxes = [
      { id: "overview", scrollHeight: 50, clientHeight: 40 },
      { id: "overview", scrollHeight: 60, clientHeight: 40 },
    ];
    expect(overflowingTableIds(boxes)).toEqual(["overview"]);
  });

  it("空入力は空配列", () => {
    expect(overflowingTableIds([])).toEqual([]);
  });

  it("tolerancePx を指定できる", () => {
    expect(overflowingTableIds([{ id: "a", scrollHeight: 105, clientHeight: 100 }], 10)).toEqual([]);
    expect(overflowingTableIds([{ id: "a", scrollHeight: 111, clientHeight: 100 }], 10)).toEqual(["a"]);
  });
});
