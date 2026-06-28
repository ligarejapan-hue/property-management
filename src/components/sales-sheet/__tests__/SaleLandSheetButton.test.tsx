import { vi, describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { SaleLandSheetButton } from "../SaleLandSheetButton";

// Node environment: test SSR output (closed state).
// Interactive click/state tests require jsdom which is not in this project's vitest setup.

describe("SaleLandSheetButton", () => {
  it("初期状態でトリガーボタン（販売図面を作成）が描画される", () => {
    const html = renderToStaticMarkup(createElement(SaleLandSheetButton, { propertyId: "p1" }));
    expect(html).toContain("販売図面を作成");
  });

  it("モーダルや価格入力フォームは存在しない（エディタ遷移型に変更済）", () => {
    const html = renderToStaticMarkup(createElement(SaleLandSheetButton, { propertyId: "p1" }));
    expect(html).not.toContain("価格");
    expect(html).not.toContain("PDFを作成");
  });

  it("propertyId が data 属性やフォームに埋め込まれない（fetch で使用）", () => {
    const html = renderToStaticMarkup(createElement(SaleLandSheetButton, { propertyId: "prop-42" }));
    // The button itself renders without a modal — no form fields visible
    expect(html).toContain("販売図面を作成");
    expect(html).not.toContain("prop-42"); // not leaked into rendered HTML
  });
});
