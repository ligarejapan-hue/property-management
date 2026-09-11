import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { formatRate, buildVariantRows, buildDmViewRows, buildLpVariantRows, buildPairRows } from "../sale-dm-letter/aggregate-view-model";
import type { SaleDmCampaign } from "@/lib/api-client";

function draft(over: Partial<SaleDmCampaign["recipients"][number]>): SaleDmCampaign["recipients"][number] {
  return {
    id: Math.random().toString(36), variantId: "v1", lpVariantId: null, propertyId: "p", recipientName: "x", recipientZip: null,
    recipientAddress: null, honorific: "様", coOwnerCount: 1, body: "", status: "sent", outcome: "none",
    deliveryStatus: "delivered", lpFirstAccessAt: null, phoneInquiryAt: null, phoneTapFirstAt: null, ...over,
  };
}

const campaign: SaleDmCampaign = {
  id: "c1", name: "x", status: "sent",
  variants: [
    { id: "v1", label: "A", designTemplate: "formal", tone: "formal", length: "medium", appeal: "price", strength: "low", extraInstruction: null, lpUrl: null },
  ],
  lpVariants: [],
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

  it("未送付(draft/confirmed)は送付数・各指標の母数に含めない(送付済みのみ集計)", () => {
    const c: SaleDmCampaign = {
      ...campaign,
      recipients: [
        draft({ variantId: "v1", status: "sent", deliveryStatus: "delivered" }),
        draft({ variantId: "v1", status: "draft", deliveryStatus: "unknown" }),     // 未送付
        draft({ variantId: "v1", status: "confirmed", deliveryStatus: "unknown" }), // 未送付
      ],
    };
    const a = buildVariantRows(c).find((r) => r.variantId === "v1")!;
    expect(a.sent).toBe(1); // 送付済み 1 件のみ(未送付 2 件は除外)
    expect(a.delivered).toBe(1);
  });
});

describe("二軸の表(設計 2026-09-08)", () => {
  const base = { propertyId: "p", recipientName: "", recipientZip: null, recipientAddress: null, honorific: "様", coOwnerCount: 1, body: "b", outcome: "none", phoneInquiryAt: null };
  const campaign = {
    id: "c", name: "n", status: "sent",
    variants: [{ id: "v1", label: "A", designTemplate: "formal", tone: "formal", length: "medium", appeal: "price", strength: "low", extraInstruction: null, lpUrl: null }],
    lpVariants: [{ id: "l1", label: "X", tone: "formal", length: "medium", appeal: "price", strength: "low", headline: null, templateFrozenAt: null }],
    recipients: [
      { ...base, id: "r1", variantId: "v1", lpVariantId: "l1", status: "sent", deliveryStatus: "delivered", lpFirstAccessAt: "2026-09-09T00:00:00Z", phoneTapFirstAt: "2026-09-09T00:05:00Z" },
      { ...base, id: "r2", variantId: "v1", lpVariantId: "l1", status: "sent", deliveryStatus: "delivered", lpFirstAccessAt: null, phoneTapFirstAt: null },
      { ...base, id: "r3", variantId: "v1", lpVariantId: null, status: "sent", deliveryStatus: "unknown", lpFirstAccessAt: null, phoneTapFirstAt: null },
      { ...base, id: "r4", variantId: "v1", lpVariantId: "l1", status: "draft", deliveryStatus: "unknown", lpFirstAccessAt: null, phoneTapFirstAt: null },
    ],
  } as unknown as SaleDmCampaign;
  it("DM型の閲覧率 = 到達かつ閲覧 ÷ 到達", () => {
    expect(buildDmViewRows(campaign)).toEqual([{ variantId: "v1", label: "A", delivered: 2, viewed: 1, viewRate: "50.0%" }]);
  });
  it("LP型ごと(LP型なしの宛先は『LP型なし(外部LP)』)・送付済みのみ・電話タップは件数と分母=閲覧の率", () => {
    expect(buildLpVariantRows(campaign)).toEqual([
      { lpVariantId: "__none__", label: "LP型なし(外部LP)", sent: 1, delivered: 0, viewed: 0, viewRate: "—", phoneTapped: 0, phoneTapLabel: "—" },
      { lpVariantId: "l1", label: "X", sent: 2, delivered: 2, viewed: 1, viewRate: "50.0%", phoneTapped: 1, phoneTapLabel: "1 / 1 (100.0%)" },
    ]);
  });
  it("組み合わせ表", () => {
    expect(buildPairRows(campaign).map((r) => r.label)).toEqual(["A × LP型なし", "A × X"]);
  });
  it("LP型が0件なら LP型の表と組み合わせ表は空(既存キャンペーンは今までどおり1表)", () => {
    const c = { ...campaign, lpVariants: [], recipients: campaign.recipients.map((r) => ({ ...r, lpVariantId: null })) } as SaleDmCampaign;
    expect(buildLpVariantRows(c)).toEqual([]);
    expect(buildPairRows(c)).toEqual([]);
  });
  it("電話タップ表示は『件数 / 閲覧数 (率%)』・率の桁は閲覧率と同じ小数1桁(例: 1/4で25.0%)", () => {
    const c = {
      ...campaign,
      recipients: [
        { ...base, id: "s1", variantId: "v1", lpVariantId: "l1", status: "sent", deliveryStatus: "delivered", lpFirstAccessAt: "2026-09-09T00:00:00Z", phoneTapFirstAt: "2026-09-09T00:05:00Z" },
        { ...base, id: "s2", variantId: "v1", lpVariantId: "l1", status: "sent", deliveryStatus: "delivered", lpFirstAccessAt: "2026-09-09T00:00:00Z", phoneTapFirstAt: null },
        { ...base, id: "s3", variantId: "v1", lpVariantId: "l1", status: "sent", deliveryStatus: "delivered", lpFirstAccessAt: "2026-09-09T00:00:00Z", phoneTapFirstAt: null },
        { ...base, id: "s4", variantId: "v1", lpVariantId: "l1", status: "sent", deliveryStatus: "delivered", lpFirstAccessAt: "2026-09-09T00:00:00Z", phoneTapFirstAt: null },
      ],
    } as unknown as SaleDmCampaign;
    const row = buildLpVariantRows(c).find((r) => r.lpVariantId === "l1")!;
    expect(row.viewed).toBe(4);
    expect(row.phoneTapped).toBe(1);
    // 閲覧率(formatRate)と同じ体裁。整数丸め(toFixed(0))に戻ると 25% になって表内で桁が揃わなくなる。
    expect(row.phoneTapLabel).toBe("1 / 4 (25.0%)");
    expect(row.viewRate).toBe("100.0%");
  });

  it("電話タップの率は集計(phoneTapRate)をそのまま表示し、view-model では割り算をしない", () => {
    const src = readFileSync(new URL("../sale-dm-letter/aggregate-view-model.ts", import.meta.url), "utf8");
    // 率の再計算(toFixed(0) などの独自計算)が戻ってきたら落とす。
    expect(src).not.toContain("toFixed(0)");
    expect(src).toContain("formatPhoneTapLabel(v.phoneTapped, v.viewed, v.phoneTapRate)");
    // api-client の SaleDmDraft が phoneTapFirstAt を持つので、局所的な型の拡張(キャスト)は要らない。
    expect(src).not.toContain("DraftWithPhoneTap");
    expect(src).not.toContain("as unknown as");
  });
});
