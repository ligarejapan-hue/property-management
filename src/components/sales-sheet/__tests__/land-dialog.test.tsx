import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

// api-client 経由の fetchPropertyDetail は SalesSheetCreateDialog が open 時に
// useEffect 内で呼ぶが、renderToStaticMarkup は effect を実行しないため、この
// SSR テストでは実際に呼ばれることはない（フェッチ後の反映はレビューで担保・
// 本ファイルは「開いた直後・フェッチ前」の静的構造のみを検証する・mansion-dialog.test.tsx と同方式）。

import { SalesSheetCreateDialog } from "../SalesSheetCreateButton";

// Node environment（jsdom 非導入）: SSR 静的構造のみ検証する。クリック/チェック操作・
// 自動反映フェッチ後の反映は対象外（interactions はレビューで担保・リポジトリ規約）。
// [F2-A Task4] ダイアログが種別駆動(FIELDS_BY_KIND)へ一般化され、land も mansion と同じ
// 汎用 widget レンダラ(FieldModelForm)を通るようになったことを検証する。
describe("SalesSheetCreateDialog（売土地・field-model 駆動）", () => {
  function render() {
    return renderToStaticMarkup(
      createElement(SalesSheetCreateDialog, {
        propertyId: "p1",
        kind: "land",
        open: true,
        onClose: () => {},
      }),
    );
  }

  it("select ウィジェットの項目（物件種目）を <select> として描画する（LAND_FIELDS 由来）", () => {
    const html = render();
    expect(html).toContain("物件種目");
    expect(html).toMatch(/<select[^>]*aria-label="物件種目"/);
    // 選択肢マスタ（PROPERTY_TYPE_LAND）の値も option として出る（マンションの
    // PROPERTY_TYPE_MANSION とは異なる選択肢＝LAND_FIELDS が実際に駆動している証拠）。
    expect(html).toContain("売地");
  });

  it("multiselect ウィジェットの項目（地目）をチェックボックス群として描画する", () => {
    const html = render();
    expect(html).toContain("地目");
    expect(html).toContain('type="checkbox"');
    // 選択肢マスタ（LAND_CATEGORY）の値がチェックボックスのラベルとして出る
    expect(html).toContain("宅地");
  });

  it("number ウィジェットの項目（価格）に単位を添えて描画する", () => {
    const html = render();
    expect(html).toMatch(/<input[^>]*aria-label="価格"/);
    expect(html).toContain("万円");
  });

  it("会社セクションの項目（取引態様）も描画する（mansion と共有のセクション定義）", () => {
    const html = render();
    expect(html).toContain("取引態様");
    expect(html).toMatch(/<select[^>]*aria-label="取引態様"/);
  });

  it("自動反映専用の項目（所在地）は disabled のプレビュー入力として描画する（LAND_AUTO_ONLY_KEYS）", () => {
    const html = render();
    expect(html).toMatch(/<input[^>]*aria-label="所在地"[^>]*disabled/);
  });

  it("キャッチコピー／セールスポイント（レイアウト専用・mansion と共有）も描画する", () => {
    const html = render();
    expect(html).toContain("キャッチコピー");
    expect(html).toContain("セールスポイント");
  });

  it("open=false は何も描画しない（既存の他種別と同じ挙動）", () => {
    const html = renderToStaticMarkup(
      createElement(SalesSheetCreateDialog, {
        propertyId: "p1",
        kind: "land",
        open: false,
        onClose: () => {},
      }),
    );
    expect(html).toBe("");
  });

  it("見出しは「販売図面（売土地）の作成」", () => {
    const html = render();
    expect(html).toContain("販売図面（売土地）の作成");
  });

  it("guard: mansion は引き続き MANSION_FIELDS 駆動で描画される（land 一般化の回帰防止）", () => {
    const html = renderToStaticMarkup(
      createElement(SalesSheetCreateDialog, {
        propertyId: "p1",
        kind: "mansion",
        open: true,
        onClose: () => {},
      }),
    );
    expect(html).toContain("販売図面（売マンション）の作成");
    expect(html).toMatch(/<select[^>]*aria-label="土地権利"/);
    expect(html).toContain("所有権");
  });
});
