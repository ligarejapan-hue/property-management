/**
 * EditorCanvas — unit tests (plan-3 Task E)
 *
 * Test approach: matches the existing component-test pattern in this repo.
 * vitest env=node → no jsdom available.
 * All assertions use renderToStaticMarkup (react-dom/server) + string checks.
 * Click/interaction behaviour is intentionally not tested here; the underlying
 * selection logic (selectElement) is already covered by Task D reducer tests.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EditorCanvas } from "../EditorCanvas";
import { sampleDocument } from "@/lib/sales-sheet/__fixtures__/sample-document";

describe("EditorCanvas — 描画", () => {
  it("A4 横寸法 (297mm × 210mm) のルート要素を描画する", () => {
    const html = renderToStaticMarkup(
      <EditorCanvas document={sampleDocument} selectedId={null} onSelect={() => {}} />,
    );
    expect(html).toContain("width:297mm");
    expect(html).toContain("height:210mm");
  });

  it("data-editor-canvas 属性を持つルート要素が存在する", () => {
    const html = renderToStaticMarkup(
      <EditorCanvas document={sampleDocument} selectedId={null} onSelect={() => {}} />,
    );
    expect(html).toContain("data-editor-canvas");
  });

  it("SalesSheetRenderer の出力 (data-sales-sheet-page) を含む", () => {
    const html = renderToStaticMarkup(
      <EditorCanvas document={sampleDocument} selectedId={null} onSelect={() => {}} />,
    );
    expect(html).toContain("data-sales-sheet-page");
  });

  it("要素数ぶんの data-hit-box 属性を描画する", () => {
    const html = renderToStaticMarkup(
      <EditorCanvas document={sampleDocument} selectedId={null} onSelect={() => {}} />,
    );
    const hitBoxCount = (html.match(/data-hit-box=/g) ?? []).length;
    expect(hitBoxCount).toBe(sampleDocument.elements.length);
  });

  it("各 hit-box ID がドキュメント要素 ID と対応する", () => {
    const html = renderToStaticMarkup(
      <EditorCanvas document={sampleDocument} selectedId={null} onSelect={() => {}} />,
    );
    for (const el of sampleDocument.elements) {
      expect(html).toContain(`data-hit-box="${el.id}"`);
    }
  });
});

describe("EditorCanvas — 選択ハイライト", () => {
  it("選択中要素のヒット枠にハイライト色 (#2563eb) が付く", () => {
    const firstId = sampleDocument.elements[0].id; // "title"
    const html = renderToStaticMarkup(
      <EditorCanvas document={sampleDocument} selectedId={firstId} onSelect={() => {}} />,
    );
    expect(html).toContain("#2563eb");
  });

  it("選択中要素の hit-box に data-selected=\"true\" が付く", () => {
    const firstId = sampleDocument.elements[0].id;
    const html = renderToStaticMarkup(
      <EditorCanvas document={sampleDocument} selectedId={firstId} onSelect={() => {}} />,
    );
    expect(html).toContain(`data-hit-box="${firstId}" data-selected="true"`);
  });

  it("選択なし時は data-selected=\"true\" が現れない", () => {
    const html = renderToStaticMarkup(
      <EditorCanvas document={sampleDocument} selectedId={null} onSelect={() => {}} />,
    );
    expect(html).not.toContain('data-selected="true"');
  });

  it("選択されていない要素の hit-box は transparent ボーダーを持つ", () => {
    // Select first element; all others should remain transparent
    const firstId = sampleDocument.elements[0].id;
    const html = renderToStaticMarkup(
      <EditorCanvas document={sampleDocument} selectedId={firstId} onSelect={() => {}} />,
    );
    // transparent border appears for non-selected elements
    expect(html).toContain("transparent");
  });

  it("異なる要素を選択するとその要素の hit-box がハイライトされる", () => {
    const lastEl = sampleDocument.elements[sampleDocument.elements.length - 1];
    const html = renderToStaticMarkup(
      <EditorCanvas document={sampleDocument} selectedId={lastEl.id} onSelect={() => {}} />,
    );
    expect(html).toContain("#2563eb");
  });
});
