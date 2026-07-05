import { vi, describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
// 住所補完 UI は本テストの対象外（内部 hooks を SSR に持ち込まない）。
vi.mock("@/components/address/address-lookup-controls", () => ({
  AddressLookupControls: () => null,
}));

import NewPropertyModal, { resolvePostCreate } from "../new-property-modal";

describe("NewPropertyModal typeFilter", () => {
  it("未指定: 旧値(building/unit)以外の全種別を描画する(店舗あり・従来挙動)", () => {
    const html = renderToStaticMarkup(createElement(NewPropertyModal, { onClose: () => {} }));
    expect(html).toContain("土地");
    expect(html).toContain("店舗");
    expect(html).not.toContain("建物（旧）");
    expect(html).not.toContain("区分（旧）");
  });

  it("指定: 指定種別のみ描画する(店舗・駐車場なし)", () => {
    const html = renderToStaticMarkup(
      createElement(NewPropertyModal, {
        onClose: () => {},
        typeFilter: ["land", "apartment_unit", "house", "apartment_building", "apartment_block"],
      }),
    );
    expect(html).toContain("土地");
    expect(html).toContain("区分マンション");
    expect(html).toContain("一棟アパート");
    expect(html).not.toContain("店舗");
    expect(html).not.toContain("駐車場");
  });
});

describe("resolvePostCreate", () => {
  it("onCreated 指定時はそれを返し router.push しない", () => {
    const onCreated = vi.fn();
    const push = vi.fn();
    resolvePostCreate(onCreated, { push })("p1", "land");
    expect(onCreated).toHaveBeenCalledWith("p1", "land");
    expect(push).not.toHaveBeenCalled();
  });

  it("未指定時は /properties/{id} へ push する(従来挙動)", () => {
    const push = vi.fn();
    resolvePostCreate(undefined, { push })("p1", "land");
    expect(push).toHaveBeenCalledWith("/properties/p1");
  });
});
