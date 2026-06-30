import { describe, it, expect } from "vitest";
import { aggregateByVariant, type AggregateDraftInput } from "../sale-dm-letter/aggregate";

const d = (over: Partial<AggregateDraftInput>): AggregateDraftInput => ({
  variantId: "A",
  deliveryStatus: "delivered",
  lpFirstAccessAt: null,
  phoneInquiryAt: null,
  ...over,
});

describe("aggregateByVariant", () => {
  it("空入力は byVariant=[]・total が全ゼロ・率は null(0除算回避)", () => {
    const r = aggregateByVariant([]);
    expect(r.byVariant).toEqual([]);
    expect(r.total.sent).toBe(0);
    expect(r.total.responseRate).toBeNull();
    expect(r.total.undeliverableRate).toBeNull();
  });

  it("送付数は型ごとの draft 数・到達は delivered のみ・宛先不明は returned_undeliverable のみ", () => {
    const r = aggregateByVariant([
      d({ variantId: "A", deliveryStatus: "delivered" }),
      d({ variantId: "A", deliveryStatus: "delivered" }),
      d({ variantId: "A", deliveryStatus: "returned_undeliverable" }),
      d({ variantId: "A", deliveryStatus: "unknown" }),
    ]);
    const a = r.byVariant.find((v) => v.variantId === "A")!;
    expect(a.sent).toBe(4);
    expect(a.delivered).toBe(2);
    expect(a.undeliverable).toBe(1);
  });

  it("反響=LP∪電話・内訳(lp/phone/both)・反響率の母数は到達数", () => {
    const r = aggregateByVariant([
      // 到達3 のうち 2 が反響(LP1 / 電話1) → 反響率 = 2/3
      d({ variantId: "A", deliveryStatus: "delivered", lpFirstAccessAt: new Date() }),
      d({ variantId: "A", deliveryStatus: "delivered", phoneInquiryAt: new Date() }),
      d({ variantId: "A", deliveryStatus: "delivered" }),
      // returned は到達に数えない(分母外)。反響シグナルがあってもカウントするが率の母数は到達
      d({ variantId: "A", deliveryStatus: "returned_undeliverable", phoneInquiryAt: new Date() }),
    ]);
    const a = r.byVariant.find((v) => v.variantId === "A")!;
    expect(a.delivered).toBe(3);
    expect(a.inquiryLp).toBe(1);
    expect(a.inquiryPhone).toBe(2); // delivered の電話1 + undeliverable の電話1
    expect(a.inquiry).toBe(3); // LP1 + 電話2(重複なし)
    // 反響率 = 到達のうち反響した数 / 到達数 = 2/3
    expect(a.responseRate).toBeCloseTo(2 / 3, 5);
  });

  it("LP と電話の両方があるドラフトは both にも数え・inquiry は1として数える", () => {
    const r = aggregateByVariant([
      d({ variantId: "A", deliveryStatus: "delivered", lpFirstAccessAt: new Date(), phoneInquiryAt: new Date() }),
    ]);
    const a = r.byVariant.find((v) => v.variantId === "A")!;
    expect(a.inquiry).toBe(1);
    expect(a.inquiryLp).toBe(1);
    expect(a.inquiryPhone).toBe(1);
    expect(a.inquiryBoth).toBe(1);
    expect(a.responseRate).toBeCloseTo(1, 5);
  });

  it("宛先不明率の母数は送付数(該当型の draft 数)", () => {
    const r = aggregateByVariant([
      d({ variantId: "A", deliveryStatus: "returned_undeliverable" }),
      d({ variantId: "A", deliveryStatus: "delivered" }),
      d({ variantId: "A", deliveryStatus: "delivered" }),
      d({ variantId: "A", deliveryStatus: "unknown" }),
    ]);
    const a = r.byVariant.find((v) => v.variantId === "A")!;
    expect(a.undeliverableRate).toBeCloseTo(1 / 4, 5);
  });

  it("型をまたいで集計し total に合算・byVariant は variantId 昇順", () => {
    const r = aggregateByVariant([
      d({ variantId: "B", deliveryStatus: "delivered", phoneInquiryAt: new Date() }),
      d({ variantId: "A", deliveryStatus: "delivered" }),
    ]);
    expect(r.byVariant.map((v) => v.variantId)).toEqual(["A", "B"]);
    expect(r.total.sent).toBe(2);
    expect(r.total.delivered).toBe(2);
    expect(r.total.inquiry).toBe(1);
    expect(r.total.responseRate).toBeCloseTo(1 / 2, 5);
  });
});
