import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BuildingLinkNotice } from "@/components/buildings/building-link-notice";

describe("BuildingLinkNotice", () => {
  it("created のとき文言と棟へのリンクを出す", () => {
    const html = renderToStaticMarkup(
      <BuildingLinkNotice
        outcome={{ action: "created", building: { id: "b1", name: "パーク第一" }, previousBuildingId: null, renamedFrom: null, warnings: [] }}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("棟「パーク第一」を新しく作りました");
    expect(html).toContain('href="/buildings/b1"');
  });
  it("注意の行は amber 色で出す", () => {
    const html = renderToStaticMarkup(
      <BuildingLinkNotice
        outcome={{ action: "linked", building: { id: "b1", name: "パーク第一" }, previousBuildingId: null, renamedFrom: null, warnings: ["duplicate_names"] }}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("text-amber-800");
    expect(html).toContain("同じ名前の棟が複数あります");
  });
  it("outcome=null は空", () => {
    expect(renderToStaticMarkup(<BuildingLinkNotice outcome={null} onClose={() => {}} />)).toBe("");
  });
});
