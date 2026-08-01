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
// capability は provider 経由。既定は「逆ジオコーディング有効」で SSR する
// (無効時の出し分けは専用テストで mock を差し替えて検証)。
vi.mock("@/components/screen-protection/screen-protection-provider", () => ({
  useScreenProtection: vi.fn(() => ({
    capabilities: { reverseGeocode: true },
  })),
}));

import ConvertPinToPropertyModal from "../convert-pin-to-property-modal";
import { useScreenProtection } from "@/components/screen-protection/screen-protection-provider";

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

  it("押す前に外部送信の事前開示を表示する(Codex R4 P2: 座標は保護対象の位置情報)", () => {
    // 初期表示(クリック前)の時点で「どこへ何を送るか」が見えること。
    const html = renderToStaticMarkup(createElement(ConvertPinToPropertyModal, props));
    expect(html).toContain("ピンの座標を国土地理院");
    expect(html).toContain("送信して住所を調べます");
    expect(html).toContain("座標以外の情報は送信しません");
  });

  it.each([
    ["未設定(false)", { capabilities: { reverseGeocode: false } }],
    ["capabilities 未取得(null)", { capabilities: null }],
  ])(
    "逆ジオコーディング %s なら導線ごと出さない(Codex R5 P2: 押すと必ず503のボタンを出さない)",
    (_label, state) => {
      (useScreenProtection as ReturnType<typeof vi.fn>).mockReturnValueOnce(state);
      const html = renderToStaticMarkup(createElement(ConvertPinToPropertyModal, props));
      expect(html).not.toContain("ピンの位置から住所を入力");
      expect(html).not.toContain("ピンの座標を国土地理院");
      // 住所欄そのもの・郵便番号補完は残る(手入力は普通にできる)。
      expect(html).toContain("この場所を物件にする");
    },
  );
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

  it("自動入力は addressEdited を false に戻す(Codex P1: 立ったままだと住所補完へ二次送信される)", () => {
    // handleSuggestAddress の成功分岐: setAddressEdited(false) があり true 化は無いこと。
    // ボタン押下前の手入力で signal が既に立っているケースも下ろす=このprogrammatic な
    // address 変化で AddressLookupControls が日本郵便へ検索を飛ばさない。
    // 既存住所の上書き保護は AddressLookupControls の確認 UI(非空住所→pending)が担う。
    const handler = source.slice(
      source.indexOf("handleSuggestAddress"),
      source.indexOf("handleSubmit"),
    );
    expect(handler).toContain("setAddress(result.address)");
    expect(handler).toContain("setAddressEdited(false)");
    expect(handler).not.toContain("setAddressEdited(true)");
  });

  it("住所差し替え時は旧住所の郵便番号を残さない(Codex R3 P2: 不一致ペアの保存防止)", () => {
    const handler = source.slice(
      source.indexOf("handleSuggestAddress"),
      source.indexOf("handleSubmit"),
    );
    // 非空の郵便番号は消す。ただし住所が実際に置き換わったときだけ(同一住所の
    // 再取得で正しい郵便番号を巻き添えにしない・R6)。
    expect(handler).toContain('setPostalCode("")');
    expect(handler).toMatch(/result\.address !== startAddress/);
    // 消したときはユーザーへ入れ直し案内を出す。
    expect(handler).toContain("郵便番号は新しい住所に合わせて入れ直してください");
  });

  it("取得中の手編集を応答で上書きしない(Codex R2 P2: 開始時の値と比較して skip)", () => {
    const handler = source.slice(
      source.indexOf("handleSuggestAddress"),
      source.indexOf("handleSubmit"),
    );
    // リクエスト開始時 snapshot と応答時の現在値(ref)を比較し、変わっていたら反映しない。
    // 郵便番号の変化も stale 扱い(候補適用は住所+郵便番号を同時に書き換えるため、
    // 片方だけ勝たせると不一致ペアになる・R8)。
    expect(handler).toContain("const startAddress = addressRef.current");
    expect(handler).toMatch(/addressRef\.current !== startAddress/);
    expect(handler).toMatch(/postalCodeRef\.current !== startZip/);
    // 反映 skip の分岐が setAddress より前にある(上書きしてから気付く順序ではない)。
    expect(handler.indexOf("addressRef.current !== startAddress")).toBeLessThan(
      handler.indexOf("setAddress(result.address)"),
    );
  });

  it("出典(国土地理院)と番・号の追記案内をユーザーに示す", () => {
    expect(source).toContain("国土地理院");
    expect(source).toContain("追記");
  });
});
