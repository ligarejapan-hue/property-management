import { beforeEach, describe, expect, it } from "vitest";
import { clearDropBatch, loadDropBatch, saveDropBatch } from "../batch";

beforeEach(() => clearDropBatch());

describe("batch(まとめて入れたファイルの表を残す)", () => {
  it("置いた表を、画面を開き直したときに読める", () => {
    saveDropBatch([{ id: 1, state: "handed" }, { id: 2, state: "ready" }]);
    expect(loadDropBatch()).toEqual([{ id: 1, state: "handed" }, { id: 2, state: "ready" }]);
  });

  it("読んだ表を書き換えても、置いたものは変わらない(写しを返す)", () => {
    saveDropBatch([{ id: 1 }]);
    const rows = loadDropBatch<{ id: number }>();
    rows.push({ id: 2 });
    expect(loadDropBatch()).toEqual([{ id: 1 }]);
  });

  it("捨てたら空", () => {
    saveDropBatch([{ id: 1 }]);
    clearDropBatch();
    expect(loadDropBatch()).toEqual([]);
  });
});
