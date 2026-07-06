import { vi, describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

// 住所補完 UI は本テストの対象外(内部 hooks を SSR に持ち込まない)。
vi.mock("@/components/address/address-lookup-controls", () => ({
  AddressLookupControls: () => null,
}));

import ConvertPinToPropertyModal from "../convert-pin-to-property-modal";

describe("ConvertPinToPropertyModal", () => {
  const props = { pinId: "pin-1", onClose: () => {}, onConverted: () => {} };

  it("種別に土地/店舗を出し、旧値(建物（旧）)は出さない", () => {
    const html = renderToStaticMarkup(createElement(ConvertPinToPropertyModal, props));
    expect(html).toContain("土地");
    expect(html).toContain("店舗");
    expect(html).not.toContain("建物（旧）");
  });

  it("この場所を物件にする 見出し・家屋番号入力・dark 対応を持つ", () => {
    const html = renderToStaticMarkup(createElement(ConvertPinToPropertyModal, props));
    expect(html).toContain("この場所を物件にする");
    expect(html).toContain("家屋番号");
    expect(html).toContain("dark:bg-gray-900");
  });
});
