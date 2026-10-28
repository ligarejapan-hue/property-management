/**
 * 物件の画面のファイルを入れる枠を1つに+まとめてある PDF の分け方(2026-10-28 発注者決定)。
 * vitest は env=node なので、描いた HTML と元のソースで確かめる。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SplitPdfDialog, { pageRangeLabel } from "../split-pdf-dialog";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const noop = async () => {};

describe("添付ファイルタブの枠は1つ", () => {
  const tab = read("src/components/properties/attachment-tab.tsx");

  it("ファイルを入れる枠は1つだけ(謄本PDFの枠は無くした)", () => {
    expect(tab.match(/<FileDropZone\b/g)).toHaveLength(1);
    expect(tab).not.toContain("謄本PDFをここにドラッグ＆ドロップ");
  });

  it("PDF は先に中身を見て、まとめてあれば分け方・謄本なら謄本として送る", () => {
    expect(tab).toContain("analyzeBundlePdf(propertyId, file)");
    expect(tab).toContain("routeForAnalysis(analysis)");
    expect(tab).toContain('uploadOne(file, "registry")');
    expect(tab).toContain("saveSplitPdf(propertyId, splitTarget.file, segments)");
  });

  it("⚠中身を見られなかったとき(謄本かもしれない)は、推測せず「謄本ですか？」と聞く", () => {
    expect(tab).toContain("let route = routeForAnalysis(analysis);");
    expect(tab).toMatch(/if \(route === "ask"\) \{\s*const answer = await askRegistry\(file\);/);
    expect(tab).toContain("このPDFの中身を確かめられませんでした。謄本ですか？");
    // 聞くときもファイル名は出さない
    const panel = tab.slice(tab.indexOf("{askTarget && ("), tab.indexOf("{pendingImages && ("));
    expect(panel).not.toMatch(/askTarget\.name/);
  });

  it("画像は行き先を聞き、最初は写真タブ(発注者決定)", () => {
    expect(tab).toContain('setImageTarget("photo");');
    expect(tab).toContain('uploadFile(propertyId, file, "photo")');
  });

  it("⚠PDF は謄本かもしれないので、除いた知らせ・失敗の知らせにファイル名を出さない", () => {
    const zone = tab.slice(tab.indexOf("<FileDropZone"), tab.indexOf("/>", tab.indexOf("<FileDropZone")));
    expect(zone).toContain("hideFileNames");
    expect(tab).toContain("fileName: `${i + 1}件目`");
  });

  it("謄本が増えたら親へ知らせる(基本情報の件数)", () => {
    expect(tab).toContain("if (registryChanged) onRegistryMutated?.();");
  });
});

describe("分け方の小窓", () => {
  const analysis = {
    pageCount: 5,
    pageKinds: ["property_summary", "map_zoning", null, "registry", "registry"],
    segments: [
      { from: 1, to: 1, kind: "property_summary" },
      { from: 2, to: 3, kind: "map_zoning" },
      { from: 4, to: 5, kind: "registry" },
    ],
    ocr: "done" as const,
    tooManyPages: false,
  };
  const file = new File([new Uint8Array([37, 80, 68, 70])], "bundle.pdf", { type: "application/pdf" });
  const html = renderToStaticMarkup(
    <SplitPdfDialog file={file} analysis={analysis} onSave={noop} onSaveWhole={noop} onCancel={() => {}} />,
  );

  it("案の書類の数・ページの範囲・行き先を出す", () => {
    expect(html).toContain("このPDFには書類が3つ入っています");
    expect(html).toContain("2〜3ページ");
    expect(html).toContain("謄本PDF(面積を読みます)");
    expect(html).toContain("添付ファイル(物件概要書)");
  });

  it("ページの間に分け目のボタン(1ページ目の前には無い)", () => {
    // 案で分かれている所(2・4ページの前)は「つなげる」、それ以外は「分ける」
    expect(html).toContain('aria-label="2ページの前をつなげる"');
    expect(html).toContain('aria-label="4ページの前をつなげる"');
    expect(html).toContain('aria-label="3ページの前で分ける"');
    expect(html).toContain('aria-label="5ページの前で分ける"');
    expect(html).not.toContain('aria-label="1ページの前');
    expect((html.match(/aria-pressed="true"/g) ?? []).length).toBe(2);
  });

  it("種類は謄本・種類の表・その他から選べ、元のファイルの種類は出さない", () => {
    expect(html).toContain('<option value="registry"');
    expect(html).toContain('<option value=""');
    expect(html).not.toContain("bundle_original");
  });

  it("押すまで保存しないことと、元の1冊を残すことを書く", () => {
    expect(html).toContain("保存を押すまでは何も保存しません");
    expect(html).toContain("まとめてあるPDF(元のファイル)");
    expect(html).toContain("分けずに1つのまま保存");
  });

  it("文字の無いページが読めなかったときは、分け目を確かめるよう知らせる", () => {
    const failed = renderToStaticMarkup(
      <SplitPdfDialog file={file} analysis={{ ...analysis, ocr: "unavailable" }} onSave={noop} onSaveWhole={noop} onCancel={() => {}} />,
    );
    expect(failed).toContain("分け目を確かめてください");
    expect(html).not.toContain("分け目を確かめてください");
  });

  it("pageRangeLabel", () => {
    expect(pageRangeLabel({ from: 3, to: 3 })).toBe("3ページ");
    expect(pageRangeLabel({ from: 14, to: 18 })).toBe("14〜18ページ");
  });
});
