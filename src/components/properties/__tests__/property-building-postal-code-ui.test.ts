/**
 * 21-C PR-2: Property / Building の 4 フォームに postalCode 入力欄 + AddressLookupControls を
 * 配線したことを source assertion で固定（node 環境＝描画テスト不可・既存構成に合わせる）。
 *
 * 検証主眼:
 *  - postalCode を form state / 送信 payload に通す（保存先 #167 へ届く）。
 *  - AddressLookupControls を zip={postalCode}/address でペア配線・mode/disabled。
 *  - addressEdited（user-edit signal・Codex P2-G）= 住所 input 直接編集時だけ true、
 *    候補 apply（onAddressChange）では立てない、edit 系は初期/再投入で false。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

const propCreate = read("src/components/properties/new-property-modal.tsx");
const propEdit = read("src/components/properties/property-edit-form.tsx");
const bldCreate = read("src/app/(dashboard)/buildings/page.tsx");
const bldEdit = read("src/app/(dashboard)/buildings/[id]/page.tsx");

/** 4 フォーム共通: AddressLookupControls 配線 + addressEdited を 1 箇所だけ true にする。 */
function assertWiring(src: string) {
  expect(src).toMatch(
    /from\s+["']@\/components\/address\/address-lookup-controls["']/,
  );
  expect(src).toContain("<AddressLookupControls");
  expect(src).toContain("addressEdited={addressEdited}");
  expect(src).toMatch(/mode="(both|postal|search)"/);
  // zip は postalCode に束ねる（保存される郵便番号）。
  expect(src).toMatch(/zip=\{[^}]*postalCode[^}]*\}/);
  // user-edit signal は住所 input の直接編集だけ（ちょうど 1 箇所）。
  expect(src.match(/setAddressEdited\(true\)/g) ?? []).toHaveLength(1);
}

describe("Property create（new-property-modal）postalCode UI（21-C PR-2）", () => {
  it("AddressLookupControls を配線し addressEdited 契約を守る", () => {
    assertWiring(propCreate);
  });
  it("postalCode を createProperty の payload に渡す", () => {
    expect(propCreate).toMatch(/postalCode:\s*postalCode\.trim\(\)\s*\|\|\s*null/);
  });
});

describe("Property edit（property-edit-form）postalCode UI（21-C PR-2）", () => {
  it("AddressLookupControls を配線し addressEdited 契約を守る", () => {
    assertWiring(propEdit);
  });
  it("FORM_FIELDS に postalCode を含む（payload へ透過）", () => {
    expect(propEdit).toMatch(/key:\s*["']postalCode["']/);
  });
  it("prop（既存値）再投入の useEffect で addressEdited=false にリセット", () => {
    expect(propEdit).toMatch(
      /setValues\(initial\)[\s\S]*?setAddressEdited\(false\)[\s\S]*?\},\s*\[property\]\)/,
    );
  });
});

describe("Building create（buildings/page）postalCode UI（21-C PR-2）", () => {
  it("AddressLookupControls を配線し addressEdited 契約を守る", () => {
    assertWiring(bldCreate);
  });
  it("postalCode を createBuilding の payload に渡す", () => {
    expect(bldCreate).toMatch(/postalCode:\s*form\.postalCode/);
  });
});

describe("Building edit（buildings/[id]）postalCode UI（21-C PR-2）", () => {
  it("AddressLookupControls を配線し addressEdited 契約を守る", () => {
    assertWiring(bldEdit);
  });
  it("postalCode を updateBuilding の payload に渡す", () => {
    expect(bldEdit).toMatch(/postalCode:\s*editForm\.postalCode\s*\|\|\s*null/);
  });
  it("編集開始（startEdit）で addressEdited=false にリセット", () => {
    expect(bldEdit).toMatch(/setAddressEdited\(false\)/);
  });
});
