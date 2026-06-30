import { vi, describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

// next/link → plain <a> so renderToStaticMarkup works in the node env (no router).
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: unknown }) =>
    createElement("a", { href }, children as never),
}));

import {
  SalesSheetListView,
  salesSheetListUrl,
  salesSheetEditHref,
} from "../SalesSheetList";

describe("salesSheetListUrl / salesSheetEditHref", () => {
  it("一覧 API の URL を組み立てる", () => {
    expect(salesSheetListUrl("p1")).toBe("/api/properties/p1/sales-sheets");
  });
  it("エディタの href を組み立てる", () => {
    expect(salesSheetEditHref("p1", "s9")).toBe("/properties/p1/sales-sheets/s9/edit");
  });
});

describe("SalesSheetListView", () => {
  it("保存済み図面が無ければ何も描画しない", () => {
    const html = renderToStaticMarkup(
      createElement(SalesSheetListView, { propertyId: "p1", sheets: [] }),
    );
    expect(html).toBe("");
  });

  it("保存済み図面をタイトル＋編集リンクで一覧表示する", () => {
    const sheets = [
      { id: "s1", title: "売土地A", updatedAt: "2026-06-30T00:00:00.000Z" },
      { id: "s2", title: "売土地B", updatedAt: "2026-06-29T00:00:00.000Z" },
    ];
    const html = renderToStaticMarkup(
      createElement(SalesSheetListView, { propertyId: "p1", sheets }),
    );
    expect(html).toContain("保存済み販売図面");
    expect(html).toContain("売土地A");
    expect(html).toContain("売土地B");
    expect(html).toContain('href="/properties/p1/sales-sheets/s1/edit"');
    expect(html).toContain('href="/properties/p1/sales-sheets/s2/edit"');
  });
});
