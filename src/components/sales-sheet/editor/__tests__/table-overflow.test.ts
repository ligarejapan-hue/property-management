import { describe, it, expect } from "vitest";
import { overflowingTableIds, liveOverflowTableIds } from "../table-overflow";

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

// 表を全部消すと、測る処理は「表が無い」で何もせずに抜ける=最後に測った記録が残り、
// 「入りきっていません」の警告が消えなかった(実機確認 132 の既知の残り)。
// 警告は**今の図面に実在する表**だけで数える。
describe("liveOverflowTableIds(今の図面に実在する表だけ)", () => {
  const doc = (ids: string[]) => ({
    elements: [
      { id: "t-1", type: "text" },
      ...ids.map((id) => ({ id, type: "table" })),
    ],
  });
  it("表を全部消したら、古い記録があっても0件", () => {
    expect(liveOverflowTableIds(["overview", "overview-detail-a"], doc([]))).toEqual([]);
  });
  it("消えた表の記録だけを落とし、残っている表は数える", () => {
    expect(liveOverflowTableIds(["overview", "overview-detail-a"], doc(["overview"]))).toEqual(["overview"]);
  });
  it("表以外の要素と同じ id は数えない", () => {
    expect(liveOverflowTableIds(["t-1"], doc([]))).toEqual([]);
  });
});

describe("配線: 編集画面は今の図面に実在する表だけで警告を数える", () => {
  it("tableOverflowCount は liveOverflowTableIds を通す", async () => {
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const src = readFileSync(resolve(process.cwd(), "src/components/sales-sheet/editor/SalesSheetEditor.tsx"), "utf8");
    expect(src).toContain("const tableOverflowCount = liveOverflowTableIds(overflowTableIds, editorState.document).length;");
  });
});
