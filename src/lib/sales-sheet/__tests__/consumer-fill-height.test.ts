/**
 * consumer-fill-height.test.ts — 主要項目の表だけ枠の底まで伸ばす(発注者判断 2026-09-16)。
 *
 * 見積もり行高(tableRowHeightMm)は実描画より大きく、主要表の枠の下に約12mmの空きが出ていた。
 * 発注者の選択は「文字は大きくせず、行の間隔を均等に広げて底まで埋める」。
 * 行数が少ない詳細表まで伸ばすと間延びする(Fix round 1 の裁定)ため、opt-in の
 * style.fillHeight を持つ表だけが <table height:100%> になることを両レンダラで固定する。
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { SalesSheetRenderer } from "@/components/sales-sheet/SalesSheetRenderer";
import { renderDocumentToHtml } from "../render-html";
import { parseSalesSheetDocument, A4_LANDSCAPE } from "../document-schema";

const doc = (style: Record<string, unknown>) =>
  parseSalesSheetDocument({
    page: A4_LANDSCAPE,
    theme: { fontFamily: '"Yu Gothic UI","Meiryo",sans-serif', accentColor: "#1f4e79" },
    elements: [
      {
        id: "t1",
        type: "table",
        x: 10,
        y: 10,
        w: 100,
        h: 60,
        z: 1,
        rows: [
          { label: "交通", value: "○○線「○○」駅 徒歩8分" },
          { label: "土地面積", value: "125.30㎡" },
        ],
        style,
      },
    ],
  });

/** <table ...> の開始タグだけを取り出す(外枠 div の height と混同しないため)。 */
const tableTag = (html: string): string => {
  const m = /<table[^>]*>/.exec(html);
  return m ? m[0] : "";
};

describe("fillHeight — 文字列レンダラ(PDF/PNG側)", () => {
  it("borderless + fillHeight で <table> に height:100% が付く", () => {
    const html = renderDocumentToHtml(doc({ borderless: true, fillHeight: true }));
    expect(tableTag(html)).toMatch(/height:\s*100%/);
  });

  it("fillHeight が無ければ <table> に height は付かない(従来どおり)", () => {
    const html = renderDocumentToHtml(doc({ borderless: true }));
    expect(tableTag(html)).not.toMatch(/height/);
  });

  it("罫線ありの表(旧ひな型)は fillHeight を指定しても出力が変わらない", () => {
    const plain = renderDocumentToHtml(doc({}));
    const withFlag = renderDocumentToHtml(doc({ fillHeight: true }));
    expect(withFlag).toBe(plain);
  });
});

describe("fillHeight — 編集画面レンダラ(parity)", () => {
  const markup = (style: Record<string, unknown>) =>
    renderToStaticMarkup(createElement(SalesSheetRenderer, { document: doc(style) }));

  it("borderless + fillHeight で <table> に height:100% が付く", () => {
    expect(tableTag(markup({ borderless: true, fillHeight: true }))).toMatch(/height:\s*100%/);
  });

  it("fillHeight が無ければ <table> に height は付かない", () => {
    expect(tableTag(markup({ borderless: true }))).not.toMatch(/height/);
  });

  it("罫線ありの表は fillHeight を無視する(旧ひな型の見た目不変)", () => {
    expect(markup({ fillHeight: true })).toBe(markup({}));
  });
});
