import { vi, describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

  it("「ピンの位置から住所を入力」ボタンを住所欄に出す(町丁目まで・無料の説明付き)", () => {
    const html = renderToStaticMarkup(createElement(ConvertPinToPropertyModal, props));
    expect(html).toContain("ピンの位置から住所を入力");
    expect(html).toContain("町丁目まで");
  });
});

describe("ConvertPinToPropertyModal 住所自動入力の配線(source)", () => {
  // SSR では onClick 後の挙動を検証できないため、実装 source で配線を固定する。
  const source = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "convert-pin-to-property-modal.tsx",
    ),
    "utf-8",
  );

  it("suggestPinAddress(api-client) を使う(座標を client で扱わない)", () => {
    expect(source).toContain("suggestPinAddress(pinId)");
    // client 側で座標から組み立てない(緯度経度の直接利用が無い)
    expect(source).not.toMatch(/pin\.(lat|lng)/);
  });

  it("自動入力で addressEdited を立てない(Codex P1: 立てると住所補完へ二次送信される)", () => {
    // handleSuggestAddress の成功分岐に setAddressEdited(true) が無いこと。
    // 既存住所の上書き保護は AddressLookupControls の確認 UI(非空住所→pending)が担う。
    const handler = source.slice(
      source.indexOf("handleSuggestAddress"),
      source.indexOf("handleSubmit"),
    );
    expect(handler).toContain("setAddress(result.address)");
    expect(handler).not.toContain("setAddressEdited(true)");
  });

  it("出典(国土地理院)と番・号の追記案内をユーザーに示す", () => {
    expect(source).toContain("国土地理院");
    expect(source).toContain("追記");
  });
});
