import { describe, it, expect } from "vitest";
import { formatRate, buildVariantRows } from "../sale-dm-letter/aggregate-view-model";
import type { SaleDmCampaign } from "@/lib/api-client";

function draft(over: Partial<SaleDmCampaign["recipients"][number]>): SaleDmCampaign["recipients"][number] {
  return {
    id: Math.random().toString(36), variantId: "v1", propertyId: "p", recipientName: "x", recipientZip: null,
    recipientAddress: null, honorific: "様", coOwnerCount: 1, body: "", status: "sent", outcome: "none",
    deliveryStatus: "delivered", lpFirstAccessAt: null, phoneInquiryAt: null, ...over,
  };
}

const campaign: SaleDmCampaign = {
  id: "c1", name: "x", status: "sent",
  variants: [
    { id: "v1", label: "A", designTemplate: "formal", tone: "formal", length: "medium", appeal: "price", strength: "low", extraInstruction: null },
  ],
  recipients: [
    draft({ deliveryStatus: "delivered", lpFirstAccessAt: "2026-06-20T00:00:00Z" }), // 到達+反響
    draft({ deliveryStatus: "delivered" }),                                          // 到達のみ
    draft({ deliveryStatus: "returned_undeliverable" }),                             // 宛先不明
  ],
};

describe("formatRate", () => {
  it("分母>0 なら百分率1桁", () => {
    expect(formatRate(1, 2)).toBe("50.0%");
  });
  it("分母0 は '—'", () => {
    expect(formatRate(0, 0)).toBe("—");
  });
});

describe("buildVariantRows", () => {
  it("型別に 送付/到達/宛先不明/反響/反響率(母数=到達)/宛先不明率 を集計", () => {
    const rows = buildVariantRows(campaign);
    expect(rows).toHaveLength(1);
    const a = rows[0];
    expect(a.label).toBe("A");
    expect(a.sent).toBe(3);
    expect(a.delivered).toBe(2);
    expect(a.undeliverable).toBe(1);
    expect(a.inquiries).toBe(1);
    expect(a.inquiryRate).toBe("50.0%");        // 反響1 / 到達2
    expect(a.undeliverableRate).toBe("33.3%");  // 宛先不明1 / 送付3
  });

  it("未到達の反響は反響率の分子から除外する(率が100%超にならない・反響総数は維持)", () => {
    const c: SaleDmCampaign = {
      ...campaign,
      recipients: [
        draft({ deliveryStatus: "delivered", lpFirstAccessAt: "2026-06-20T00:00:00Z" }),               // 到達+反響
        draft({ deliveryStatus: "returned_undeliverable", lpFirstAccessAt: "2026-06-20T00:00:00Z" }),  // 未到達だが反響
      ],
    };
    const a = buildVariantRows(c)[0];
    expect(a.delivered).toBe(1);
    expect(a.inquiries).toBe(2);          // 反響総数(表示用)は到達状況に関わらず維持
    expect(a.inquiryRate).toBe("100.0%"); // 率の分子=到達かつ反響=1 / 到達1 → 100%(>100%にならない)
  });
});
