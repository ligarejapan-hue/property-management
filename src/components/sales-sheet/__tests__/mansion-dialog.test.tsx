import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

// api-client 経由の fetchPropertyDetail は SalesSheetCreateDialog が open 時に
// useEffect 内で呼ぶが、renderToStaticMarkup は effect を実行しないため、この
// SSR テストでは実際に呼ばれることはない（フェッチ後の反映はレビューで担保・
// 本ファイルは「開いた直後・フェッチ前」の静的構造のみを検証する）。

import { SalesSheetCreateDialog } from "../SalesSheetCreateButton";

// Node environment（jsdom 非導入）: SSR 静的構造のみ検証する。クリック/チェック操作・
// 自動反映フェッチ後の反映は対象外（interactions はレビューで担保・リポジトリ規約）。
describe("SalesSheetCreateDialog（売マンション・field-model 駆動）", () => {
  function render() {
    return renderToStaticMarkup(
      createElement(SalesSheetCreateDialog, {
        propertyId: "p1",
        kind: "mansion",
        open: true,
        onClose: () => {},
      }),
    );
  }

  it("select ウィジェットの項目（土地権利）を <select> として描画する", () => {
    const html = render();
    expect(html).toContain("土地権利");
    expect(html).toMatch(/<select[^>]*aria-label="土地権利"/);
    // 選択肢マスタ（LAND_RIGHT）の値も option として出る
    expect(html).toContain("所有権");
  });

  it("multiselect ウィジェットの項目（用途地域）をチェックボックス群として描画する", () => {
    const html = render();
    expect(html).toContain("用途地域");
    expect(html).toContain('type="checkbox"');
    // 選択肢マスタ（USE_DISTRICT）の値がチェックボックスのラベルとして出る
    expect(html).toContain("商業地域");
  });

  it("number ウィジェットの項目（価格）に単位を添えて描画する", () => {
    const html = render();
    expect(html).toMatch(/<input[^>]*aria-label="価格"/);
    expect(html).toContain("万円");
  });

  it("showWhen の項目（うち消費税）は制御フィールド未達のため初期状態では描画されない", () => {
    const html = render();
    // 消費税(tax) の初期値は空文字列のため、showWhen: {field:"tax", equals:"課税"} の
    // taxAmount(うち消費税) は表示されない。
    expect(html).not.toContain("うち消費税");
  });

  it("controlOnly の項目（消費税）は showWhen を駆動するため描画される", () => {
    const html = render();
    expect(html).toMatch(/<select[^>]*aria-label="消費税"/);
    expect(html).toContain("不課税");
  });

  it("会社セクションの項目（取引態様）も描画する（フッター用・表の行にはならない）", () => {
    const html = render();
    expect(html).toContain("取引態様");
    expect(html).toMatch(/<select[^>]*aria-label="取引態様"/);
  });

  it("自動反映専用の項目（専有面積）は disabled のプレビュー入力として描画する", () => {
    const html = render();
    expect(html).toMatch(/<input[^>]*aria-label="専有面積"[^>]*disabled/);
  });

  it("キャッチコピー／セールスポイント（レイアウト専用）も描画する", () => {
    const html = render();
    expect(html).toContain("キャッチコピー");
    expect(html).toContain("セールスポイント");
  });

  it("open=false は何も描画しない（既存の他種別と同じ挙動）", () => {
    const html = renderToStaticMarkup(
      createElement(SalesSheetCreateDialog, {
        propertyId: "p1",
        kind: "mansion",
        open: false,
        onClose: () => {},
      }),
    );
    expect(html).toBe("");
  });
});
