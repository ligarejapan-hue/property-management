import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import PropertyEditForm from "../property-edit-form";

/**
 * F3 Task7 fix レビュー対応(2回差し戻し分の引き取り)。
 *
 * `property-edit-form-building-fields-readonly.test.ts` は `salesFieldsFor` の
 * 戻り値とソースコードの正規表現スキャンで固定しており、**実際に描かれる画面を
 * 見ていない**(JSX 側で入力欄が復活しても検知できない)との指摘を受けた。
 *
 * 本ファイルは `renderToStaticMarkup` で `PropertyEditForm` を実際に描画し、
 * 出力された HTML 文字列そのものを見て固定する。
 *
 * ⚠`PropertyEditForm` は client component だが、`renderToStaticMarkup` は
 * **初回描画だけ**を行い `useEffect` は実行されない。そのため `fetchUsers` 等の
 * 通信は走らない(先例: `src/components/sales-sheet/editor/__tests__/element-panel.test.tsx`)。
 *
 * ⚠実装(`property-edit-form.tsx`)を見ると、通常の入力欄(text/number)には
 * `name` / `id` / `aria-label` のいずれの属性も付いていない(`data-testid` は
 * clearOnly 欄と上限超過メッセージにしか無い)。そのため「その項目の入力欄か」の
 * 判定は、実際に出力された HTML の中で `<label>ラベル文言</label>` の**直後**に
 * `<input>` タグが続くかどうか(= フォームが実際に描いている label→input の隣接構造)
 * で行う。ラベル文言が本文中に出現するだけでは真としない
 * (読み取り専用ブロックは「構造 RC / 地上階 10 / …」のように `<label>` タグを介さない
 * 地の文でラベルと同じ語を含むため、これと区別する必要がある)。
 * `salesFieldsFor` の戻り値は一切参照しない。
 */

type BuildingRef = NonNullable<
  Parameters<typeof PropertyEditForm>[0]["property"]["building"]
>;

// PropertyEditForm の PropertyData 型に合わせた最小フィクスチャ。
function makeProperty(
  propertyType: string,
  building: BuildingRef | null,
): Parameters<typeof PropertyEditForm>[0]["property"] {
  return {
    id: "prop-1",
    propertyType,
    address: "東京都千代田区丸の内1-1-1",
    lotNumber: null,
    buildingNumber: null,
    buildingName: null,
    realEstateNumber: null,
    registryStatus: "unconfirmed",
    dmStatus: "hold",
    gpsLat: null,
    gpsLng: null,
    zoningDistrict: null,
    buildingCoverageRatio: null,
    floorAreaRatio: null,
    heightDistrict: null,
    firePreventionZone: null,
    scenicRestriction: null,
    roadType: null,
    roadWidth: null,
    frontageWidth: null,
    frontageDirection: null,
    setbackRequired: null,
    rosenkaValue: null,
    rosenkaYear: null,
    rebuildPermission: null,
    architectureNote: null,
    note: null,
    assignedTo: null,
    version: 1,
    salePrice: null,
    saleTaxType: null,
    saleTaxAmount: null,
    access: null,
    landArea: null,
    landAreaMethod: null,
    totalFloorArea: null,
    builtYear: null,
    builtMonth: null,
    structureType: null,
    aboveFloors: null,
    basementFloors: null,
    parking: null,
    totalUnits: null,
    grossYield: null,
    expectedIncome: null,
    exclusiveArea: null,
    balconyArea: null,
    layoutType: null,
    orientation: null,
    floorNo: null,
    managementFee: null,
    repairReserveFee: null,
    building,
  };
}

const testBuilding: BuildingRef = {
  id: "building-42",
  name: "テストマンション",
  structureType: "RC",
  totalFloors: 10,
  totalUnits: 20,
  basementFloors: 1,
  builtYear: 2000,
  builtMonth: 4,
};

/** value を正規表現の特殊文字としてではなくリテラルとして扱う。 */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 出力 HTML の中に、指定ラベルに対応する「実際に編集できる入力欄」が
 * 存在するか。`<label>ラベル</label>` の直後に `<input>` が続く箇所を探す
 * (renderToStaticMarkup は同一行内の隣接要素間に空白を挿入しない)。
 */
function hasEditableInputFor(html: string, label: string): boolean {
  const re = new RegExp(`<label[^>]*>${escapeForRegExp(label)}</label><input`);
  return re.test(html);
}

const BUILDING_FIELD_LABELS = ["構造", "地上階", "地下階", "総戸数", "築年", "築月"];

describe("PropertyEditForm レンダリング固定: 区分マンションの棟項目は読み取り専用(F3 Task7 fix)", () => {
  describe("apartment_unit(区分マンション・棟に紐づく)", () => {
    const html = renderToStaticMarkup(
      <PropertyEditForm
        property={makeProperty("apartment_unit", testBuilding)}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );

    it.each(BUILDING_FIELD_LABELS)(
      "棟項目「%s」の入力欄(label→input)が出力に存在しない",
      (label) => {
        expect(hasEditableInputFor(html, label)).toBe(false);
      },
    );

    it("読み取り専用ブロックの文言が出力に存在する", () => {
      expect(html).toContain("棟の項目(この画面では変更できません)");
    });

    it("「棟の画面で直す」リンクが出力に存在し、/buildings/<棟のid> を指す", () => {
      expect(html).toContain("棟の画面で直す");
      expect(html).toContain(`href="/buildings/${testBuilding.id}"`);
    });

    it("読み取り専用ブロックには棟の実データ(構造・地上階など)が表示される", () => {
      expect(html).toContain("構造 RC");
      expect(html).toContain("地上階");
      expect(html).toContain("地下階");
      expect(html).toContain("総戸数");
    });
  });

  describe("apartment_building(一棟)は比較対象: 同じ項目が編集可能な入力欄として出る", () => {
    const html = renderToStaticMarkup(
      <PropertyEditForm
        property={makeProperty("apartment_building", null)}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );

    it.each(BUILDING_FIELD_LABELS)(
      "棟項目「%s」の入力欄(label→input)が出力に存在する",
      (label) => {
        expect(hasEditableInputFor(html, label)).toBe(true);
      },
    );

    it("読み取り専用ブロックの文言は出力に存在しない(区分だけが読み取り専用)", () => {
      expect(html).not.toContain("棟の項目(この画面では変更できません)");
    });

    it("「棟の画面で直す」リンクも出力に存在しない", () => {
      expect(html).not.toContain("棟の画面で直す");
    });
  });
});

// [@codex P2] 築年と築月は片方だけでも保存できる。読み取り専用の棟ブロックが年・月の
// 単位を直書きしていたため、月が未入力の棟では「2020年—月」と読めない表示になっていた。
// (この節も走査ではなく実際に描かれた HTML を見る)
describe("PropertyEditForm レンダリング固定: 棟の築年月(@codex P2)", () => {
  const renderWith = (b: BuildingRef) =>
    renderToStaticMarkup(
      <PropertyEditForm
        property={makeProperty("apartment_unit", b)}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );

  it("年月が揃っていれば年月で出す", () => {
    expect(renderWith({ ...testBuilding, builtYear: 2000, builtMonth: 4 })).toContain("2000年4月");
  });

  it("月が未入力なら「—月」を付けない", () => {
    const html = renderWith({ ...testBuilding, builtYear: 2020, builtMonth: null });
    expect(html).toContain("2020年");
    expect(html).not.toContain("2020年—月");
  });

  it("月だけでも消さずに出す", () => {
    const html = renderWith({ ...testBuilding, builtYear: null, builtMonth: 3 });
    expect(html).toContain("3月");
    expect(html).not.toContain("—年3月");
  });

  it("どちらも無ければ年月の欄は「—」だけ", () => {
    const html = renderWith({ ...testBuilding, builtYear: null, builtMonth: null });
    expect(html).not.toContain("—年—月");
  });
});
