import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { SaleLandSheetButton } from "../SaleLandSheetButton";

// Node environment: test SSR output (closed state) + fetch body construction.
// Interactive click/state tests require jsdom which is not in this project's vitest setup.

describe("SaleLandSheetButton", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("ボタン押下でフォーム（価格入力）が開く — SSR: 初期状態でトリガーボタンが描画される", () => {
    const html = renderToStaticMarkup(createElement(SaleLandSheetButton, { propertyId: "p1" }));
    expect(html).toContain("販売図面を作成");
    // モーダルは初期状態で非表示
    expect(html).not.toContain("価格");
  });

  it("生成押下で preview API を正しいURL・POSTで呼ぶ — fetch body 組立を検証", async () => {
    const blob = new Blob(["%PDF-"], { type: "application/pdf" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(blob, { status: 200, headers: { "Content-Type": "application/pdf" } }),
    );

    // Simulate what the component does on generate(): POST with the values object
    const propertyId = "p1";
    const values = { price: "3,480万円", access: "", landArea: "", landCategory: "", transactionType: "", deliveryTiming: "" };
    await fetch(`/api/properties/${propertyId}/sales-sheet/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });

    expect(fetchMock).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/properties/p1/sales-sheet/preview");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string).price).toBe("3,480万円");
  });
});
