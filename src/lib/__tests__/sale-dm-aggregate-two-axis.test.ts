import { describe, it, expect } from "vitest";
import { aggregateTwoAxis, LP_NONE } from "../sale-dm-letter/aggregate";

const d = (variantId: string, lpVariantId: string | null, deliveryStatus: string, viewed: boolean, phoneTap = false) => ({
  variantId, lpVariantId, deliveryStatus, lpFirstAccessAt: viewed ? new Date() : null, phoneInquiryAt: null,
  phoneTapFirstAt: phoneTap ? new Date() : null,
});

describe("aggregateTwoAxis", () => {
  it("DM型ごとの閲覧率(到達かつ閲覧 ÷ 到達)を出す", () => {
    const r = aggregateTwoAxis([
      d("A", "X", "delivered", true), d("A", "X", "delivered", false), d("A", "Y", "returned_undeliverable", true),
      d("B", "Y", "delivered", false),
    ]);
    expect(r.byDmVariant).toEqual([
      { variantId: "A", sent: 3, delivered: 2, viewed: 2, deliveredViewed: 1, viewRate: 0.5 },
      { variantId: "B", sent: 1, delivered: 1, viewed: 0, deliveredViewed: 0, viewRate: 0 },
    ]);
  });
  it("LP型ごとと組み合わせごとを出し、到達0は率 null", () => {
    const r = aggregateTwoAxis([d("A", "X", "unknown", true), d("B", "X", "delivered", true), d("A", "Y", "delivered", false)]);
    expect(r.byLpVariant).toEqual([
      { lpVariantId: "X", sent: 2, delivered: 1, viewed: 2, deliveredViewed: 1, viewRate: 1, phoneTapped: 0, phoneTapRate: 0 },
      { lpVariantId: "Y", sent: 1, delivered: 1, viewed: 0, deliveredViewed: 0, viewRate: 0, phoneTapped: 0, phoneTapRate: null },
    ]);
    expect(r.byPair).toEqual([
      { variantId: "A", lpVariantId: "X", sent: 1, delivered: 0, viewed: 1 },
      { variantId: "A", lpVariantId: "Y", sent: 1, delivered: 1, viewed: 0 },
      { variantId: "B", lpVariantId: "X", sent: 1, delivered: 1, viewed: 1 },
    ]);
    expect(aggregateTwoAxis([d("A", "X", "unknown", true)]).byLpVariant[0].viewRate).toBeNull();
  });
  it("LP型なし(null)の宛先は LP_NONE にまとめ、総数は宛先数と一致する", () => {
    const r = aggregateTwoAxis([d("A", null, "delivered", false), d("A", "X", "delivered", true)]);
    expect(r.byLpVariant.map((x) => x.lpVariantId)).toEqual([LP_NONE, "X"]);
    expect(r.byLpVariant.reduce((s, x) => s + x.sent, 0)).toBe(2);
    expect(r.byPair.reduce((s, x) => s + x.sent, 0)).toBe(2);
  });
  it("空なら空", () => {
    expect(aggregateTwoAxis([])).toEqual({ byDmVariant: [], byLpVariant: [], byPair: [] });
  });
  it("電話タップの件数と率(分母=閲覧・閲覧0は率null・閲覧なしのタップも分子に数える)", () => {
    const r = aggregateTwoAxis([
      d("A", "X", "delivered", true, true),   // 閲覧+タップ
      d("A", "X", "delivered", true, false),  // 閲覧のみ
      d("A", "X", "delivered", false, true),  // タップのみ(閲覧なし)
      d("B", "Y", "delivered", false, false), // 閲覧0のLP型
    ]);
    const x = r.byLpVariant.find((v) => v.lpVariantId === "X")!;
    expect(x.viewed).toBe(2);
    expect(x.phoneTapped).toBe(2); // 閲覧の有無に関わらずタップは独立に数える
    expect(x.phoneTapRate).toBe(1); // 2 / 2
    const y = r.byLpVariant.find((v) => v.lpVariantId === "Y")!;
    expect(y.viewed).toBe(0);
    expect(y.phoneTapped).toBe(0);
    expect(y.phoneTapRate).toBeNull(); // 閲覧0は率なし
  });
});
