import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FieldModelForm, computeMansionAutoValues, mansionAreaPreview } from "../SalesSheetCreateButton";
import { MANSION_FIELDS } from "@/lib/sales-sheet/field-model";

// 区分の専有面積は2つ(2026-10-24)。作成画面の表示は図面と同じく面積計測方式で切り替える(@codex PR#578 P2)。
describe("販売図面の作成画面: 専有面積の表示は面積計測方式に合わせる", () => {
  const auto = computeMansionAutoValues({ address: "東京都A区B1-2-3", exclusiveArea: "67.21", exclusiveAreaRegistry: "63.5" });

  it("★内法なら登記簿の面積を出す", () => {
    expect(mansionAreaPreview({ areaMethod: "内法" }, auto.preview).value).toBe("63.5");
  });

  it("★壁芯・未選択なら壁芯の面積を出し、登記簿の面積があることを添える", () => {
    const cases: Record<string, string>[] = [{ areaMethod: "壁芯" }, {}];
    for (const values of cases) {
      const r = mansionAreaPreview(values, auto.preview);
      expect(r.value).toBe("67.21");
      expect(r.hint).toContain("63.5㎡");
    }
  });

  it("★内法なのに登記簿の面積が無ければ、空になることを知らせる", () => {
    const noRegistry = computeMansionAutoValues({ address: "東京都A区B1-2-3", exclusiveArea: "67.21" });
    const r = mansionAreaPreview({ areaMethod: "内法" }, noRegistry.preview);
    expect(r.value).toBe("");
    expect(r.hint).toContain("空になります");
  });

  it("★作成画面の専有面積の欄が、内法を選ぶと登記簿の数字になる(案内も出る)", () => {
    const html = renderToStaticMarkup(
      createElement(FieldModelForm, {
        kind: "mansion",
        sections: [["建物", MANSION_FIELDS.filter((f) => f.key === "exclusiveArea")]],
        autoOnlyKeys: new Set(["exclusiveArea"]),
        values: { areaMethod: "内法" },
        onChange: () => {},
        autoPreview: auto.preview,
        hints: {},
      }),
    );
    expect(html).toContain('value="63.5"');
    expect(html).not.toContain('value="67.21"');
    expect(html).toContain("登記簿の面積を入れます");
  });
});
