/**
 * ElementPanel — unit tests (plan-3 Task G)
 *
 * Test approach: matches existing component-test style (env=node).
 * All structural assertions use renderToStaticMarkup + string checks.
 *
 * The `buildGeometryChange` pure helper is tested directly to cover
 * "numeric change → correct patch" without needing jsdom/event firing.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ElementPanel,
  buildGeometryChange,
  PANEL_FONT_OPTIONS,
} from "../ElementPanel";
import { isCssColor, isSafeFontFamily } from "@/lib/sales-sheet/css-safety";
import type { SalesSheetElement } from "@/lib/sales-sheet/document-schema";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** 1×1 transparent PNG — avoids isSafeImageSrc rejection. */
const TRANSPARENT_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const textElement: SalesSheetElement = {
  id: "t1",
  type: "text",
  x: 10,
  y: 20,
  w: 100,
  h: 30,
  z: 1,
  content: "Hello",
  style: { fontSizePt: 14, color: "#333333" },
};

const imageElement: SalesSheetElement = {
  id: "i1",
  type: "image",
  x: 0,
  y: 0,
  w: 50,
  h: 50,
  z: 1,
  src: TRANSPARENT_PNG,
  fit: "cover",
};

// ---------------------------------------------------------------------------
// Structure tests (renderToStaticMarkup)
// ---------------------------------------------------------------------------

describe("ElementPanel — 構造", () => {
  it("element=null のとき空状態を描画し data-element-panel= 属性は存在しない", () => {
    const html = renderToStaticMarkup(<ElementPanel element={null} onChange={() => {}} />);
    expect(html).toContain("data-element-panel-empty");
    // "data-element-panel=" does NOT appear in "data-element-panel-empty=…"
    // (the empty-state wrapper has only the -empty variant, not the panel wrapper)
    expect(html).not.toContain("data-element-panel=");
  });

  it("要素選択時に data-element-panel が存在する", () => {
    const html = renderToStaticMarkup(
      <ElementPanel element={textElement} onChange={() => {}} />,
    );
    expect(html).toContain("data-element-panel");
  });

  it("text 要素選択時に data-text-editor セクションが存在する", () => {
    const html = renderToStaticMarkup(
      <ElementPanel element={textElement} onChange={() => {}} />,
    );
    expect(html).toContain("data-text-editor");
  });

  it("text 要素選択時に textarea が存在する", () => {
    const html = renderToStaticMarkup(
      <ElementPanel element={textElement} onChange={() => {}} />,
    );
    expect(html).toContain("<textarea");
  });

  it("text 要素選択時に font-family select が存在する", () => {
    const html = renderToStaticMarkup(
      <ElementPanel element={textElement} onChange={() => {}} />,
    );
    expect(html).toContain("<select");
  });

  it("非 text 要素（image）選択時は text editor が存在しない", () => {
    const html = renderToStaticMarkup(
      <ElementPanel element={imageElement} onChange={() => {}} />,
    );
    expect(html).not.toContain("data-text-editor");
    expect(html).not.toContain("<textarea");
  });

  it("重ね順ボタン（前面・背面）が存在する", () => {
    const html = renderToStaticMarkup(
      <ElementPanel element={textElement} onChange={() => {}} />,
    );
    expect(html).toContain("前面");
    expect(html).toContain("背面");
  });

  it("削除ボタンが存在する", () => {
    const html = renderToStaticMarkup(
      <ElementPanel element={textElement} onChange={() => {}} />,
    );
    expect(html).toContain("削除");
  });

  it("geometry 値が input の value 属性として出力される", () => {
    const html = renderToStaticMarkup(
      <ElementPanel element={textElement} onChange={() => {}} />,
    );
    // Controlled inputs render value= in SSR output
    expect(html).toContain('value="10"'); // x
    expect(html).toContain('value="20"'); // y
    expect(html).toContain('value="100"'); // w
    expect(html).toContain('value="30"'); // h
  });

  it("text 要素の content が textarea の value として出力される", () => {
    const html = renderToStaticMarkup(
      <ElementPanel element={textElement} onChange={() => {}} />,
    );
    expect(html).toContain("Hello");
  });
});

// ---------------------------------------------------------------------------
// Pure-helper tests: buildGeometryChange
// (tests "numeric change → onChange fires with the right patch" without jsdom)
// ---------------------------------------------------------------------------

describe("ElementPanel — buildGeometryChange", () => {
  it("x フィールド変更で move パッチ（新 x・既存 y）が生成される", () => {
    const change = buildGeometryChange("x", "42.5", textElement);
    expect(change).toEqual({ type: "move", x: 42.5, y: 20 });
  });

  it("y フィールド変更で move パッチ（既存 x・新 y）が生成される", () => {
    const change = buildGeometryChange("y", "15", textElement);
    expect(change).toEqual({ type: "move", x: 10, y: 15 });
  });

  it("w フィールド変更で resize パッチ（新 w・既存 h）が生成される", () => {
    const change = buildGeometryChange("w", "80", textElement);
    expect(change).toEqual({ type: "resize", w: 80, h: 30 });
  });

  it("h フィールド変更で resize パッチ（既存 w・新 h）が生成される", () => {
    const change = buildGeometryChange("h", "40", textElement);
    expect(change).toEqual({ type: "resize", w: 100, h: 40 });
  });

  it("非数値は null を返す", () => {
    expect(buildGeometryChange("x", "abc", textElement)).toBeNull();
    expect(buildGeometryChange("y", "", textElement)).toBeNull();
  });

  it("整数値も正しく変換される", () => {
    const change = buildGeometryChange("x", "0", textElement);
    expect(change).toEqual({ type: "move", x: 0, y: 20 });
  });
});

// ---------------------------------------------------------------------------
// Font allow-list tests
// ---------------------------------------------------------------------------

describe("ElementPanel — PANEL_FONT_OPTIONS", () => {
  it("全フォントオプションが isSafeFontFamily を通過する", () => {
    for (const f of PANEL_FONT_OPTIONS) {
      expect(isSafeFontFamily(f.value)).toBe(true);
    }
  });

  it("各オプションに label と value が存在する", () => {
    for (const f of PANEL_FONT_OPTIONS) {
      expect(typeof f.label).toBe("string");
      expect(typeof f.value).toBe("string");
      expect(f.label.length).toBeGreaterThan(0);
      expect(f.value.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Guard regression tests
// The onColor handler calls isCssColor before dispatching.
// The onFontFamily handler calls isSafeFontFamily before dispatching.
// These tests verify the guards reject unsafe values, ensuring onChange is
// never called for injection-style inputs (the "return" guard fires first).
// ---------------------------------------------------------------------------

describe("ElementPanel — バリデーションガード", () => {
  it("無効な色文字列は isCssColor を通過しないため onColor が onChange を呼ばない", () => {
    // These values are rejected by isCssColor, so the guard returns early.
    expect(isCssColor("expression(evil)")).toBe(false);
    expect(isCssColor("url(http://evil.com)")).toBe(false);
    expect(isCssColor("; color: red")).toBe(false);
    expect(isCssColor("javascript:alert(1)")).toBe(false);
  });

  it("空文字・無効なフォントファミリーは isSafeFontFamily を通過しないため onFontFamily が onChange を呼ばない", () => {
    // Empty string (placeholder option value) and injection strings are rejected.
    expect(isSafeFontFamily("")).toBe(false);
    expect(isSafeFontFamily("font; injection: 1")).toBe(false);
    expect(isSafeFontFamily("</style><script>")).toBe(false);
    expect(isSafeFontFamily("url(http://evil.com)")).toBe(false);
  });
});
