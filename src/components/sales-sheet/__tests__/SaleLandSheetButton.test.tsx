import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { SaleLandSheetButton, buildPreviewRequest } from "../SaleLandSheetButton";

// Node environment: test SSR output (closed state) + pure request-builder.
// Interactive click/state tests require jsdom which is not in this project's vitest setup.

describe("SaleLandSheetButton", () => {
  it("ボタン押下でフォーム（価格入力）が開く — SSR: 初期状態でトリガーボタンが描画される", () => {
    const html = renderToStaticMarkup(createElement(SaleLandSheetButton, { propertyId: "p1" }));
    expect(html).toContain("販売図面を作成");
    // モーダルは初期状態で非表示
    expect(html).not.toContain("価格");
  });
});

describe("buildPreviewRequest", () => {
  it("正しいURL・POST・JSON bodyを返す", () => {
    const values = {
      price: "3,480万円",
      access: "渋谷駅徒歩5分",
      landArea: "",
      landCategory: "",
      transactionType: "",
      deliveryTiming: "",
    };
    const { url, init } = buildPreviewRequest("prop-42", values);

    expect(url).toBe("/api/properties/prop-42/sales-sheet/preview");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    const parsed = JSON.parse(init.body as string);
    expect(parsed.price).toBe("3,480万円");
    expect(parsed.access).toBe("渋谷駅徒歩5分");
    expect(parsed.landArea).toBe("");
  });

  it("propertyId がURLに正しく埋め込まれる", () => {
    const { url } = buildPreviewRequest("abc-123", {});
    expect(url).toBe("/api/properties/abc-123/sales-sheet/preview");
  });

  it("valuesが空オブジェクトでも空のJSONオブジェクトをbodyに返す", () => {
    const { init } = buildPreviewRequest("p1", {});
    expect(JSON.parse(init.body as string)).toEqual({});
  });
});
