/**
 * applyMasterSelection / applySourceSelection の pure 関数テスト。
 *
 * duplicate グループの master/source ペア選択 UI で role swap が
 * 正しく動くことを担保する。
 */
import { describe, it, expect } from "vitest";
import {
  applyMasterSelection,
  applySourceSelection,
  type MergePair,
} from "../owner-merge-pair";

describe("applyMasterSelection", () => {
  it("空状態から master を選ぶ → master=id / source=null", () => {
    const r = applyMasterSelection({ masterId: null, sourceId: null }, "A");
    expect(r).toEqual({ masterId: "A", sourceId: null });
  });

  it("master を別の owner に変更（source 未選択）→ master だけ更新", () => {
    const r = applyMasterSelection({ masterId: "A", sourceId: null }, "B");
    expect(r).toEqual({ masterId: "B", sourceId: null });
  });

  it("source に選ばれている owner を master に → swap", () => {
    // master=A, source=B の状態で master に B を選ぶ → master=B, source=A
    const r = applyMasterSelection({ masterId: "A", sourceId: "B" }, "B");
    expect(r).toEqual({ masterId: "B", sourceId: "A" });
  });

  it("既に master の owner を再度 master に → 変化なし", () => {
    const r = applyMasterSelection({ masterId: "A", sourceId: "B" }, "A");
    expect(r).toEqual({ masterId: "A", sourceId: "B" });
  });

  it("3 人グループで master を別 owner に切り替え（source は維持）", () => {
    const r = applyMasterSelection({ masterId: "A", sourceId: "B" }, "C");
    expect(r).toEqual({ masterId: "C", sourceId: "B" });
  });

  it("結果は決して master===source にならない（swap ケース）", () => {
    const r = applyMasterSelection({ masterId: "A", sourceId: "B" }, "B");
    expect(r.masterId).not.toBe(r.sourceId);
  });
});

describe("applySourceSelection", () => {
  it("空状態から source を選ぶ → source=id / master=null", () => {
    const r = applySourceSelection({ masterId: null, sourceId: null }, "A");
    expect(r).toEqual({ masterId: null, sourceId: "A" });
  });

  it("source を別の owner に変更（master 未選択）→ source だけ更新", () => {
    const r = applySourceSelection({ masterId: null, sourceId: "A" }, "B");
    expect(r).toEqual({ masterId: null, sourceId: "B" });
  });

  it("master に選ばれている owner を source に → swap", () => {
    // master=A, source=B の状態で source に A を選ぶ → master=B, source=A
    const r = applySourceSelection({ masterId: "A", sourceId: "B" }, "A");
    expect(r).toEqual({ masterId: "B", sourceId: "A" });
  });

  it("既に source の owner を再度 source に → 変化なし", () => {
    const r = applySourceSelection({ masterId: "A", sourceId: "B" }, "B");
    expect(r).toEqual({ masterId: "A", sourceId: "B" });
  });

  it("3 人グループで source を別 owner に切り替え（master は維持）", () => {
    const r = applySourceSelection({ masterId: "A", sourceId: "B" }, "C");
    expect(r).toEqual({ masterId: "A", sourceId: "C" });
  });

  it("結果は決して master===source にならない（swap ケース）", () => {
    const r = applySourceSelection({ masterId: "A", sourceId: "B" }, "A");
    expect(r.masterId).not.toBe(r.sourceId);
  });
});

describe("ペア入れ替えシナリオ (2 人グループ)", () => {
  it("A/B 選択後に master=B にすると source=A に swap される", () => {
    const initial = { masterId: "A", sourceId: "B" };
    const next = applyMasterSelection(initial, "B");
    expect(next).toEqual({ masterId: "B", sourceId: "A" });
  });

  it("A/B 選択後に source=A にすると master=B に swap される", () => {
    const initial = { masterId: "A", sourceId: "B" };
    const next = applySourceSelection(initial, "A");
    expect(next).toEqual({ masterId: "B", sourceId: "A" });
  });

  it("連続 swap で元に戻せる", () => {
    let pair: MergePair = { masterId: "A", sourceId: "B" };
    pair = applyMasterSelection(pair, "B");
    expect(pair).toEqual({ masterId: "B", sourceId: "A" });
    pair = applyMasterSelection(pair, "A");
    expect(pair).toEqual({ masterId: "A", sourceId: "B" });
  });
});

describe("3 人グループでのペア選び直し", () => {
  it("A/B 選択後に master=C / source=A に変更できる", () => {
    let pair: MergePair = { masterId: "A", sourceId: "B" };
    pair = applyMasterSelection(pair, "C"); // master を C に
    expect(pair).toEqual({ masterId: "C", sourceId: "B" });
    pair = applySourceSelection(pair, "A"); // source を A に
    expect(pair).toEqual({ masterId: "C", sourceId: "A" });
  });

  it("3 人グループで master / source を完全に入れ替えられる", () => {
    // A/B 選択後に B/C へ
    let pair: MergePair = { masterId: "A", sourceId: "B" };
    pair = applyMasterSelection(pair, "B"); // master を B (source と swap)
    expect(pair).toEqual({ masterId: "B", sourceId: "A" });
    pair = applySourceSelection(pair, "C"); // source を C
    expect(pair).toEqual({ masterId: "B", sourceId: "C" });
  });
});
