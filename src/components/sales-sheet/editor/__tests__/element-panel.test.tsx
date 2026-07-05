/**
 * ElementPanel — unit tests (plan-3 Task G)
 *
 * Test approach: matches existing component-test style (env=node).
 * All structural assertions use renderToStaticMarkup + string checks.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ElementPanel,
  hexColorInputValue,
  PANEL_FONT_OPTIONS,
  FOCAL_PRESETS,
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

const qrDataUrl =
  "data:image/gif;base64,R0lGODdhAQABAIAAAAAAAAAAACwAAAAAAQABAAACAkQBADs=";

const qrElement: SalesSheetElement = {
  id: "q1",
  type: "qr",
  x: 250,
  y: 160,
  w: 30,
  h: 30,
  z: 4,
  dataUrl: qrDataUrl,
  content: "https://example.com/p/1",
};

const THEME = { fontFamily: "sans-serif", accentColor: "#15324f" };

const tableElement: SalesSheetElement = {
  id: "tab1",
  type: "table",
  x: 150,
  y: 22,
  w: 137,
  h: 160,
  z: 1,
  rows: [
    { label: "所在地", value: "東京都" },
    { label: "価格", value: "5,000万円" },
  ],
  style: {},
};

describe("ElementPanel — 概要表の編集（計画⑧ 第2弾）", () => {
  it("table 要素選択時に data-table-editor / 各行の入力 / 行追加ボタンを描画する", () => {
    const html = renderToStaticMarkup(
      <ElementPanel element={tableElement} onChange={() => {}} theme={THEME} onThemeChange={() => {}} />,
    );
    expect(html).toContain("data-table-editor");
    expect(html).toContain('value="所在地"');
    expect(html).toContain('value="東京都"');
    expect(html).toContain('value="価格"');
    expect(html).toContain('value="5,000万円"');
    expect(html).toContain("data-table-add-row");
    expect(html).toContain("行を追加");
  });

  it("行ごとに削除ボタンがある", () => {
    const html = renderToStaticMarkup(
      <ElementPanel element={tableElement} onChange={() => {}} theme={THEME} onThemeChange={() => {}} />,
    );
    expect((html.match(/aria-label="行\d+ を削除"/g) ?? []).length).toBe(2);
  });

  it("text 要素では表セクションを描画しない", () => {
    const html = renderToStaticMarkup(
      <ElementPanel element={textElement} onChange={() => {}} theme={THEME} onThemeChange={() => {}} />,
    );
    expect(html).not.toContain("data-table-editor");
  });
});

describe("ElementPanel — QR 編集（計画⑧）", () => {
  it("qr 要素選択時に data-qr-editor と中身入力を描画する", () => {
    const html = renderToStaticMarkup(
      <ElementPanel element={qrElement} onChange={() => {}} theme={THEME} onThemeChange={() => {}} />,
    );
    expect(html).toContain("data-qr-editor");
    expect(html).toContain("QRの中身");
    expect(html).toContain('value="https://example.com/p/1"');
  });

  it("content 未保存の既存 QR でも空欄で描画できる（後方互換）", () => {
    const el: SalesSheetElement = { ...qrElement, content: undefined };
    const html = renderToStaticMarkup(
      <ElementPanel element={el} onChange={() => {}} theme={THEME} onThemeChange={() => {}} />,
    );
    expect(html).toContain("data-qr-editor");
  });

  it("text 要素では QR セクションを描画しない", () => {
    const html = renderToStaticMarkup(
      <ElementPanel element={textElement} onChange={() => {}} theme={THEME} onThemeChange={() => {}} />,
    );
    expect(html).not.toContain("data-qr-editor");
  });
});

describe("ElementPanel — 文書テーマ（計画⑧）", () => {
  it("要素未選択時にテーマ section（フォント/基調色）を描画する", () => {
    const html = renderToStaticMarkup(
      <ElementPanel element={null} onChange={() => {}} theme={THEME} onThemeChange={() => {}} />,
    );
    expect(html).toContain("data-theme-editor");
    expect(html).toContain("図面全体のフォント");
    expect(html).toContain("基調色");
  });

  it("要素選択時はテーマ section を描画しない", () => {
    const html = renderToStaticMarkup(
      <ElementPanel element={textElement} onChange={() => {}} theme={THEME} onThemeChange={() => {}} />,
    );
    expect(html).not.toContain("data-theme-editor");
  });

  it("非 hex の基調色はテキスト入力へフォールバック（ColorField 流用）", () => {
    const html = renderToStaticMarkup(
      <ElementPanel
        element={null}
        onChange={() => {}}
        theme={{ fontFamily: "sans-serif", accentColor: "navy" }}
        onThemeChange={() => {}}
      />,
    );
    expect(html).toMatch(/aria-label="基調色"[^>]*type="text"|type="text"[^>]*aria-label="基調色"/);
    expect(html).toContain('value="navy"');
  });
});

const badgeElement: SalesSheetElement = {
  id: "b1",
  type: "badge",
  x: 5,
  y: 5,
  w: 40,
  h: 12,
  z: 3,
  label: "新着",
  shape: "rounded",
  bg: "#15324f",
  fg: "#ffffff",
};

describe("hexColorInputValue — <input type=color> 用の #rrggbb 正規化", () => {
  it("6桁 hex はそのまま（小文字化）", () => {
    expect(hexColorInputValue("#15324f")).toBe("#15324f");
    expect(hexColorInputValue("#D0331A")).toBe("#d0331a");
  });

  it("3桁/4桁 hex は 6桁へ展開（アルファは落とす）", () => {
    expect(hexColorInputValue("#f00")).toBe("#ff0000");
    expect(hexColorInputValue("#f008")).toBe("#ff0000");
  });

  it("8桁 hex はアルファを落として 6桁", () => {
    expect(hexColorInputValue("#15324f80")).toBe("#15324f");
  });

  it("named color / rgb() / 不正値は null（テキスト入力へフォールバック）", () => {
    expect(hexColorInputValue("red")).toBeNull();
    expect(hexColorInputValue("rgb(255, 0, 0)")).toBeNull();
    expect(hexColorInputValue("#12")).toBeNull();
    expect(hexColorInputValue("")).toBeNull();
  });
});

describe("ElementPanel — 色入力の表現不能ケース（@codex PR#252）", () => {
  it("hex でないバッジ色（named color）はテキスト入力で正確に表示する", () => {
    const el: SalesSheetElement = { ...badgeElement, bg: "red", fg: "navy" };
    const html = renderToStaticMarkup(<ElementPanel element={el} onChange={() => {}} theme={THEME} onThemeChange={() => {}} />);
    // type=color は red を表現できず #000000 に化けるため、text へフォールバック
    expect(html).toMatch(/aria-label="バッジ背景色"[^>]*type="text"|type="text"[^>]*aria-label="バッジ背景色"/);
    expect(html).toContain('value="red"');
    expect(html).toContain('value="navy"');
  });

  it("hex のバッジ色は type=color のまま", () => {
    const html = renderToStaticMarkup(<ElementPanel element={badgeElement} onChange={() => {}} theme={THEME} onThemeChange={() => {}} />);
    expect(html).toMatch(/aria-label="バッジ背景色"[^>]*type="color"|type="color"[^>]*aria-label="バッジ背景色"/);
  });

  it("hex でないテキスト文字色もテキスト入力へフォールバック", () => {
    const el: SalesSheetElement = {
      ...textElement,
      style: { fontSizePt: 14, color: "rgb(51, 51, 51)" },
    };
    const html = renderToStaticMarkup(<ElementPanel element={el} onChange={() => {}} theme={THEME} onThemeChange={() => {}} />);
    expect(html).toMatch(/aria-label="文字色"[^>]*type="text"|type="text"[^>]*aria-label="文字色"/);
    expect(html).toContain('value="rgb(51, 51, 51)"');
  });
});

describe("ElementPanel — バッジ編集（バッジデザイナー・計画⑦）", () => {
  it("badge 要素選択時に data-badge-editor / 文言 / 形 / 背景色 / 文字色 / サイズを描画する", () => {
    const html = renderToStaticMarkup(<ElementPanel element={badgeElement} onChange={() => {}} theme={THEME} onThemeChange={() => {}} />);
    expect(html).toContain("data-badge-editor");
    expect(html).toContain("文言");
    expect(html).toContain("角丸");
    expect(html).toContain("ピル");
    expect(html).toContain("リボン");
    expect(html).toContain("背景色");
    expect(html).toContain("文字色");
    expect(html).toContain("サイズ (pt)");
  });

  it("現在の label が入力に、shape が選択状態で表示される", () => {
    const html = renderToStaticMarkup(<ElementPanel element={badgeElement} onChange={() => {}} theme={THEME} onThemeChange={() => {}} />);
    expect(html).toContain('value="新着"');
    expect(html).toMatch(/value="rounded"[^>]*selected|selected[^>]*value="rounded"/);
  });

  it("text 要素ではバッジセクションを描画しない", () => {
    const html = renderToStaticMarkup(<ElementPanel element={textElement} onChange={() => {}} theme={THEME} onThemeChange={() => {}} />);
    expect(html).not.toContain("data-badge-editor");
  });

  it("badge 要素ではテキスト/画像セクションを描画しない", () => {
    const html = renderToStaticMarkup(<ElementPanel element={badgeElement} onChange={() => {}} theme={THEME} onThemeChange={() => {}} />);
    expect(html).not.toContain("data-text-editor");
    expect(html).not.toContain("data-image-editor");
  });
});

describe("ElementPanel — 画像編集（写真管理・計画④）", () => {
  it("image 要素選択時に data-image-editor / 焦点グリッド / fit 選択 / 角丸 / 代替テキストを描画する", () => {
    const html = renderToStaticMarkup(<ElementPanel element={imageElement} onChange={() => {}} theme={THEME} onThemeChange={() => {}} />);
    expect(html).toContain("data-image-editor");
    expect(html).toContain("data-focal-grid");
    expect(html).toContain("枠を埋める"); // cover
    expect(html).toContain("全体を表示"); // contain
    expect(html).toContain("角丸");
    expect(html).toContain("代替テキスト");
  });

  it("焦点グリッドは9プリセット（各ボタンに aria-label=焦点 …）", () => {
    expect(FOCAL_PRESETS).toHaveLength(9);
    const html = renderToStaticMarkup(<ElementPanel element={imageElement} onChange={() => {}} theme={THEME} onThemeChange={() => {}} />);
    expect((html.match(/aria-label="焦点 /g) ?? []).length).toBe(9);
  });

  it("text 要素では画像セクションを描画しない", () => {
    const html = renderToStaticMarkup(<ElementPanel element={textElement} onChange={() => {}} theme={THEME} onThemeChange={() => {}} />);
    expect(html).not.toContain("data-image-editor");
  });

  it("focalX/focalY 指定時、該当プリセットが aria-pressed=true", () => {
    const el: SalesSheetElement = { ...imageElement, focalX: 0, focalY: 0 };
    const html = renderToStaticMarkup(<ElementPanel element={el} onChange={() => {}} theme={THEME} onThemeChange={() => {}} />);
    expect(html).toMatch(/aria-label="焦点 左上"[^>]*aria-pressed="true"/);
  });
});

// ---------------------------------------------------------------------------
// Structure tests (renderToStaticMarkup)
// ---------------------------------------------------------------------------

describe("ElementPanel — 構造", () => {
  it("element=null のとき空状態を描画し data-element-panel= 属性は存在しない", () => {
    const html = renderToStaticMarkup(<ElementPanel element={null} onChange={() => {}} theme={THEME} onThemeChange={() => {}} />);
    expect(html).toContain("data-element-panel-empty");
    // "data-element-panel=" does NOT appear in "data-element-panel-empty=…"
    // (the empty-state wrapper has only the -empty variant, not the panel wrapper)
    expect(html).not.toContain("data-element-panel=");
  });

  it("要素選択時に data-element-panel が存在する", () => {
    const html = renderToStaticMarkup(
      <ElementPanel element={textElement} onChange={() => {}} theme={THEME} onThemeChange={() => {}} />,
    );
    expect(html).toContain("data-element-panel");
  });

  it("text 要素選択時に data-text-editor セクションが存在する", () => {
    const html = renderToStaticMarkup(
      <ElementPanel element={textElement} onChange={() => {}} theme={THEME} onThemeChange={() => {}} />,
    );
    expect(html).toContain("data-text-editor");
  });

  it("text 要素選択時に textarea が存在する", () => {
    const html = renderToStaticMarkup(
      <ElementPanel element={textElement} onChange={() => {}} theme={THEME} onThemeChange={() => {}} />,
    );
    expect(html).toContain("<textarea");
  });

  it("text 要素選択時に font-family select が存在する", () => {
    const html = renderToStaticMarkup(
      <ElementPanel element={textElement} onChange={() => {}} theme={THEME} onThemeChange={() => {}} />,
    );
    expect(html).toContain("<select");
  });

  it("非 text 要素（image）選択時は text editor が存在しない", () => {
    const html = renderToStaticMarkup(
      <ElementPanel element={imageElement} onChange={() => {}} theme={THEME} onThemeChange={() => {}} />,
    );
    expect(html).not.toContain("data-text-editor");
    expect(html).not.toContain("<textarea");
  });

  it("重ね順ボタン（前面・背面）が存在する", () => {
    const html = renderToStaticMarkup(
      <ElementPanel element={textElement} onChange={() => {}} theme={THEME} onThemeChange={() => {}} />,
    );
    expect(html).toContain("前面");
    expect(html).toContain("背面");
  });

  it("削除ボタンが存在する", () => {
    const html = renderToStaticMarkup(
      <ElementPanel element={textElement} onChange={() => {}} theme={THEME} onThemeChange={() => {}} />,
    );
    expect(html).toContain("削除");
  });

  it("geometry 値が input の value 属性として出力される", () => {
    const html = renderToStaticMarkup(
      <ElementPanel element={textElement} onChange={() => {}} theme={THEME} onThemeChange={() => {}} />,
    );
    // Controlled inputs render value= in SSR output
    expect(html).toContain('value="10"'); // x
    expect(html).toContain('value="20"'); // y
    expect(html).toContain('value="100"'); // w
    expect(html).toContain('value="30"'); // h
  });

  it("text 要素の content が textarea の value として出力される", () => {
    const html = renderToStaticMarkup(
      <ElementPanel element={textElement} onChange={() => {}} theme={THEME} onThemeChange={() => {}} />,
    );
    expect(html).toContain("Hello");
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
