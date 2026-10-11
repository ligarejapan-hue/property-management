import { describe, it, expect } from "vitest";
import { keepSelectionIfShown } from "../selection";

describe("keepSelectionIfShown(添付先の選択は表示中の物件だけ)", () => {
  it("★検索をやり直して前の物件が表示から消えたら、選択を外す(@codex PR#500 8巡目)", () => {
    expect(keepSelectionIfShown("old", ["a", "b"])).toBeNull();
  });
  it("まだ表示されていれば選択を残す", () => {
    expect(keepSelectionIfShown("a", ["a", "b"])).toBe("a");
  });
  it("未選択は未選択のまま", () => {
    expect(keepSelectionIfShown(null, ["a"])).toBeNull();
  });
});
