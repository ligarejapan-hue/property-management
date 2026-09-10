import { describe, it, expect } from "vitest";
import { choiceFromMedia, mediaFromChoice, setSectionChoice, setHero, assetCountOf, figureDataUrl, isPlanDirty } from "../../components/sale-dm/lp-media-panel-model";
import type { SaleDmLpMediaPlan } from "../api-client";

const plan: SaleDmLpMediaPlan = { hero: { assetId: "a1" }, sections: [{ heading: "h1", media: null }, { heading: "h2", media: { kind: "asset", assetId: "a1" } }] };

describe("lp-media-panel-model", () => {
  it("枠の値と選択肢を相互変換する", () => {
    expect(choiceFromMedia(null)).toEqual({ kind: "none" });
    expect(choiceFromMedia({ kind: "figure", figureKind: "sale_flow" })).toEqual({ kind: "figure", figureKind: "sale_flow" });
    expect(mediaFromChoice({ kind: "none" })).toBeNull();
    expect(mediaFromChoice({ kind: "asset", assetId: "x" })).toEqual({ kind: "asset", assetId: "x" });
  });
  it("節の変更は元を壊さず、その見出しだけ変える", () => {
    const next = setSectionChoice(plan, "h1", { kind: "figure", figureKind: "vacant_burden" });
    expect(next.sections[0].media).toEqual({ kind: "figure", figureKind: "vacant_burden" });
    expect(next.sections[1]).toEqual(plan.sections[1]);
    expect(plan.sections[0].media).toBeNull();
  });
  it("ヒーローの差し替え/解除・写真数は重複なし", () => {
    expect(setHero(plan, null).hero).toBeNull();
    expect(setHero(plan, "a2").hero).toEqual({ assetId: "a2" });
    expect(assetCountOf(plan)).toBe(1);
    expect(assetCountOf(setHero(plan, "a2"))).toBe(2);
  });
  it("図の見本は data URL の SVG(外部参照なし)", () => {
    const u = figureDataUrl("sale_flow");
    expect(u.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    const decoded = decodeURIComponent(u.slice(u.indexOf(",") + 1));
    expect(decoded).toContain("<svg");
    // ⚠ svg の xmlns 宣言(必須の名前空間URI・ネットワーク参照ではない)を除けば
    //   "http" は現れない = 外部リソースへの参照が無いことの確認。
    expect(decoded.replace('xmlns="http://www.w3.org/2000/svg"', "")).not.toContain("http");
  });
  it("変更の有無", () => {
    expect(isPlanDirty(plan, { ...plan })).toBe(false);
    expect(isPlanDirty(plan, setHero(plan, null))).toBe(true);
  });
});
