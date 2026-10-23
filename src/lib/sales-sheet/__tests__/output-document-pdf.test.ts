import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isChromiumAvailable, renderHtmlToPdfDocument } from "../output";

const SRC = readFileSync(join(process.cwd(), "src/lib/sales-sheet/output.ts"), "utf8").replace(/\r\n/g, "\n");

describe("何ページにもなる書類の PDF(取引の帳票)", () => {
  it("ページを1枚目に限らず、用紙は HTML の @page に従う・同時実行の上限と外部遮断を使う", () => {
    const body = SRC.slice(SRC.indexOf("export async function renderHtmlToPdfDocument"));
    const fn = body.slice(0, body.indexOf("\n}\n"));
    expect(fn).toContain("RENDER_GATE.run(");
    expect(fn).toContain("withPage(html,");
    expect(fn).toContain("preferCSSPageSize: true");
    expect(fn).toContain("printBackground: true");
    expect(fn).not.toContain("pageRanges");
  });

  it.skipIf(!isChromiumAvailable())(
    "2ページ分の HTML から 2 ページの PDF ができる",
    async () => {
      const html = `<!doctype html><html><head><style>@page{size:A4 portrait;margin:10mm}</style></head><body>
<div style="height:200mm">1ページ目</div><div style="page-break-before:always">2ページ目</div></body></html>`;
      const pdf = await renderHtmlToPdfDocument(html);
      expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      const pages = pdf.toString("latin1").match(/\/Type\s*\/Page(?!s)/g) ?? [];
      expect(pages.length).toBe(2);
    },
    60_000,
  );
});
