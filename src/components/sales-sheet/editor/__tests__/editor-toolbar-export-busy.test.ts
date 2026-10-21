/**
 * 販売図面の「PDF出力」「PNG出力」: 押したほうのボタンだけが「出力中…」になる(2026-10-21)。
 * これまでは1つの exporting を2つのボタンで共有し、PNG を押しても PDF のボタンが「出力中…」になっていた。
 * vitest は env=node でクリックできないため、判定は純関数で見て、ボタンがその判定を自分の形式で使っているかを
 * ソースで確かめる。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isExportingFormat } from "../EditorToolbar";

describe("isExportingFormat", () => {
  it("何も出力していないときは、どちらのボタンも出力中ではない", () => {
    expect(isExportingFormat(null, "pdf")).toBe(false);
    expect(isExportingFormat(null, "png")).toBe(false);
  });

  it("PNG を出力中なら PNG だけが出力中(PDF は出力中にならない)", () => {
    expect(isExportingFormat("png", "png")).toBe(true);
    expect(isExportingFormat("png", "pdf")).toBe(false);
  });

  it("PDF を出力中なら PDF だけが出力中", () => {
    expect(isExportingFormat("pdf", "pdf")).toBe(true);
    expect(isExportingFormat("pdf", "png")).toBe(false);
  });
});

describe("EditorToolbar の出力ボタン", () => {
  const src = readFileSync(
    join(process.cwd(), "src/components/sales-sheet/editor/EditorToolbar.tsx"),
    "utf8",
  ).replace(/\r\n/g, "\n");

  /** data-toolbar-export="<format>" を持つ <Button ...> の開きタグ。 */
  const openTag = (format: string) => {
    const at = src.indexOf(`data-toolbar-export="${format}"`);
    expect(at, `data-toolbar-export="${format}" が無い`).toBeGreaterThan(-1);
    const start = src.lastIndexOf("<Button", at);
    const end = src.indexOf("</Button>", at);
    return src.slice(start, end);
  };

  it.each(["pdf", "png"])("%s のボタンは自分の形式で出力中を判定する", (format) => {
    expect(openTag(format)).toContain(`isExportingFormat(exporting, "${format}")`);
  });

  it("出力中の文言は「出力中…」のまま", () => {
    expect(openTag("pdf")).toContain('loadingLabel="出力中…"');
    expect(openTag("png")).toContain('loadingLabel="出力中…"');
  });
});
