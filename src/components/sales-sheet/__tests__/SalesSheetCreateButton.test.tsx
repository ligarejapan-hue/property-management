import { vi, describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { SalesSheetCreateButton, SalesSheetCreateDialog } from "../SalesSheetCreateButton";

// Node environment: closed-state SSR のみ検証（クリック/モーダル操作は jsdom 非導入のため対象外）。
describe("SalesSheetCreateButton", () => {
  it.each([
    ["land", "売土地"],
    ["mansion", "売マンション"],
    ["house", "売戸建"],
    ["building", "一棟"],
  ] as const)("kind=%s → トリガーボタンに『販売図面を作成（%s）』", (kind, label) => {
    const html = renderToStaticMarkup(
      createElement(SalesSheetCreateButton, { propertyId: "p1", canWrite: true, kind }),
    );
    expect(html).toContain(`販売図面を作成（${label}）`);
  });

  it("read-only（canWrite=false）は何も描画しない（403 dead-end を出さない）", () => {
    const html = renderToStaticMarkup(
      createElement(SalesSheetCreateButton, { propertyId: "p1", canWrite: false, kind: "mansion" }),
    );
    expect(html).toBe("");
  });

  it("閉じた状態では入力フォーム（各項目ラベル）を描画しない", () => {
    const html = renderToStaticMarkup(
      createElement(SalesSheetCreateButton, { propertyId: "p1", canWrite: true, kind: "building" }),
    );
    // モーダルは既定で閉じているため、一棟固有の入力ラベルは出ない。
    expect(html).not.toContain("想定利回り");
    expect(html).not.toContain("総戸数");
  });
});

describe("SalesSheetCreateDialog（切り出し・制御コンポーネント）", () => {
  // 一棟 open=true の field-model 駆動レンダリングは building-dialog.test.tsx へ移設
  // （[F2-C Task3]・house/land/mansion と同じ dialog テスト形）。ここでは種別非依存の
  // open=false 挙動のみ確認する。
  it("open=false は何も描画しない", () => {
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
});
