import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

// api-client 経由の fetchPropertyDetail は open 時に useEffect 内で呼ぶが、
// renderToStaticMarkup は effect を実行しないため、この SSR テストでは呼ばれない
// （フェッチ後の反映はレビューで担保・house-dialog.test.tsx と同方式）。

import { SalesSheetCreateDialog } from "../SalesSheetCreateButton";

// Node environment（jsdom 非導入）: SSR 静的構造のみ検証する。クリック/チェック操作・
// 自動反映フェッチ後の反映は対象外（interactions はレビューで担保・リポジトリ規約）。
// [F2-C Task3] ダイアログが一棟用の field-model(BUILDING_FIELDS) へ配線され、house/land/
// mansion と同じ汎用 widget レンダラ(FieldModelForm)を通ることを検証する。
describe("SalesSheetCreateDialog（一棟・field-model 駆動）", () => {
  function render() {
    return renderToStaticMarkup(
      createElement(SalesSheetCreateDialog, {
        propertyId: "p1",
        kind: "building",
        open: true,
        onClose: () => {},
      }),
    );
  }

  it("select ウィジェットの項目（物件種目）を <select> として描画する（BUILDING_FIELDS 由来）", () => {
    const html = render();
    expect(html).toMatch(/<select[^>]*aria-label="物件種目"/);
    // PROPERTY_TYPE_BUILDING の値（他種別には無い一棟固有の選択肢）が option として出る。
    expect(html).toContain("一棟ビル");
  });

  it("付帯権利（landRight を再利用）を <select> として描画する（LAND_RIGHT の値を持つ）", () => {
    const html = render();
    expect(html).toMatch(/<select[^>]*aria-label="付帯権利"/);
    expect(html).toContain("所有権");
  });

  it("controlOnly の項目（消費税）を <select> として描画する（house/mansion と同じ tax/taxAmount 欄）", () => {
    const html = render();
    expect(html).toMatch(/<select[^>]*aria-label="消費税"/);
    expect(html).toContain("課税");
  });

  it("showWhen の項目（うち消費税）は制御フィールド未達のため初期状態では描画されない", () => {
    const html = render();
    expect(html).not.toContain("うち消費税");
  });

  it("収益系（総戸数）を number 入力として描画し、単位(戸)を添える", () => {
    const html = render();
    expect(html).toMatch(/<input[^>]*aria-label="総戸数"/);
    expect(html).toContain("戸");
  });

  it("収益系（想定利回り／満室想定収入）の入力を描画する", () => {
    const html = render();
    expect(html).toMatch(/<input[^>]*aria-label="想定利回り"/);
    expect(html).toContain("満室想定収入(年額)");
  });

  it("multiselect ウィジェットの項目（地目・用途地域）をチェックボックス群として描画する", () => {
    const html = render();
    expect(html).toContain("地目");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("宅地");
    expect(html).toContain("用途地域");
    expect(html).toContain("第一種低層住居専用地域");
  });

  it("number ウィジェットの項目（延床面積）に単位(㎡)を添えて描画する", () => {
    const html = render();
    expect(html).toMatch(/<input[^>]*aria-label="延床面積"/);
    expect(html).toContain("㎡");
  });

  it("会社セクションの項目（取引態様）も描画する（他種別と共有のセクション定義）", () => {
    const html = render();
    expect(html).toMatch(/<select[^>]*aria-label="取引態様"/);
  });

  it("自動反映専用の項目（所在地）は disabled のプレビュー入力として描画する（BUILDING_AUTO_ONLY_KEYS）", () => {
    const html = render();
    expect(html).toMatch(/<input[^>]*aria-label="所在地"[^>]*disabled/);
  });

  it("一棟は間取り(layout)フィールドを持たない（BUILDING_FIELDS に layout 無し）", () => {
    const html = render();
    expect(html).not.toMatch(/aria-label="間取り"/);
  });

  it("キャッチコピー／セールスポイント（レイアウト専用・他種別と共有）も描画する", () => {
    const html = render();
    expect(html).toContain("キャッチコピー");
    expect(html).toContain("セールスポイント");
  });

  it("見出しは「販売図面（一棟）の作成」", () => {
    const html = render();
    expect(html).toContain("販売図面（一棟）の作成");
  });

  it("open=false は何も描画しない", () => {
    const html = renderToStaticMarkup(
      createElement(SalesSheetCreateDialog, {
        propertyId: "p1",
        kind: "building",
        open: false,
        onClose: () => {},
      }),
    );
    expect(html).toBe("");
  });

  it("guard: house は引き続き HOUSE_FIELDS 駆動で描画される（一棟配線の回帰防止）", () => {
    const html = renderToStaticMarkup(
      createElement(SalesSheetCreateDialog, {
        propertyId: "p1",
        kind: "house",
        open: true,
        onClose: () => {},
      }),
    );
    expect(html).toContain("販売図面（売戸建）の作成");
    expect(html).toMatch(/<input[^>]*aria-label="間取り"[^>]*disabled/);
  });
});
