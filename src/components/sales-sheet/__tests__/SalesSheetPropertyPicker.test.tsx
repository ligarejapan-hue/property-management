import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { SalesSheetPropertyPicker } from "../SalesSheetPropertyPicker";
import type { PickerRow } from "../../../lib/sales-sheet/picker";

const baseProps = {
  rows: [] as PickerRow[],
  canWrite: true,
  keywordInput: "",
  onKeywordInputChange: () => {},
  loading: false,
  error: null as string | null,
  page: 1,
  totalPages: 1,
  total: 0,
  onPageChange: () => {},
  onSelect: () => {},
  onOpenRegister: () => {},
};

const rows: PickerRow[] = [
  { id: "p1", address: "東京都杉並区高円寺南3-24-8", typeLabel: "土地", kind: "land", updatedAt: "2026-07-01T00:00:00Z" },
  { id: "p2", address: "東京都中野区本町2-15", typeLabel: "店舗", kind: null, updatedAt: "2026-07-01T00:00:00Z" },
];

describe("SalesSheetPropertyPicker", () => {
  it("行に種別バッジ+住所を描画し、作成可能行(kind 非null)だけ『作成 →』を出す", () => {
    const html = renderToStaticMarkup(
      createElement(SalesSheetPropertyPicker, { ...baseProps, rows, total: 2 }),
    );
    expect(html).toContain("土地");
    expect(html).toContain("東京都杉並区高円寺南3-24-8");
    const marks = html.match(/作成 →/g) ?? [];
    expect(marks.length).toBe(1);
  });

  it("canWrite=false: 登録ボタンも『作成 →』も出さない(一覧閲覧のみ)", () => {
    const html = renderToStaticMarkup(
      createElement(SalesSheetPropertyPicker, { ...baseProps, rows, canWrite: false, total: 2 }),
    );
    expect(html).not.toContain("新しい物件を登録して作成");
    expect(html).not.toContain("作成 →");
  });

  it("空状態: メッセージ+canWrite のときだけ登録誘導", () => {
    const html = renderToStaticMarkup(createElement(SalesSheetPropertyPicker, { ...baseProps }));
    expect(html).toContain("対象の物件が見つかりません");
    expect(html).toContain("そのまま図面を作成できます");
    const htmlRo = renderToStaticMarkup(
      createElement(SalesSheetPropertyPicker, { ...baseProps, canWrite: false }),
    );
    expect(htmlRo).toContain("対象の物件が見つかりません");
    expect(htmlRo).not.toContain("そのまま図面を作成できます");
  });

  it("error があれば表示する", () => {
    const html = renderToStaticMarkup(
      createElement(SalesSheetPropertyPicker, { ...baseProps, error: "物件一覧の閲覧権限がありません" }),
    );
    expect(html).toContain("物件一覧の閲覧権限がありません");
  });

  it("複数ページのときだけ 前へ/次へ を出す", () => {
    const one = renderToStaticMarkup(
      createElement(SalesSheetPropertyPicker, { ...baseProps, rows, total: 2 }),
    );
    expect(one).not.toContain("次へ");
    const multi = renderToStaticMarkup(
      createElement(SalesSheetPropertyPicker, { ...baseProps, rows, total: 120, totalPages: 3, page: 2 }),
    );
    expect(multi).toContain("前へ");
    expect(multi).toContain("次へ");
    expect(multi).toContain("全 120 件");
  });
});
