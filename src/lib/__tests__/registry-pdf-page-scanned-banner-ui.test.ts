/**
 * registry-pdf import page F-1: scanned PDF 警告バナーの UI source-assertion テスト。
 *
 * - isLikelyScanned 時にバナーを描画する条件分岐が存在する
 * - 「画像化された謄本PDF」「OCR」「手動」を含む文言を表示する
 * - 警告バナーに data-testid="scanned-pdf-banner" / role="alert" が付与されている
 * - OCR を実装していない（外部 OCR/tesseract 等の import がない）
 * - サーバーレスポンスから extractionSource / isLikelyScanned を受け取る
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const pageSrc = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/(dashboard)/import/registry-pdf/page.tsx",
  ),
  "utf8",
);

// コメントを取り除く。⚠経緯の説明はコメントに書き残したいので、
// 「画面に出るか」を見る検査はコメントを外してから行う。
// 行頭が // の行と、ブロックコメントだけを落とす(URL の // は残す)。
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
}

describe("import/registry-pdf page F-1 scanned 警告バナー", () => {
  it("isLikelyScanned state を保持している", () => {
    expect(pageSrc).toMatch(/\[\s*isLikelyScanned\s*,\s*setIsLikelyScanned\s*\]/);
  });

  it("isLikelyScanned で条件分岐し data-testid と role=alert を持つバナーを描画する", () => {
    expect(pageSrc).toMatch(
      /\{\s*isLikelyScanned\s*&&[\s\S]{0,400}data-testid=("|')scanned-pdf-banner\1/,
    );
    expect(pageSrc).toMatch(/role=("|')alert\1/);
  });

  it("バナーは「画像化謄本PDF」と、次にやること(貼り付け)を伝える", () => {
    expect(pageSrc).toMatch(/画像化された謄本PDF/);
    // ⚠OCR の語は 2026-09-08 に画面から撤去(機能はサーバー側に残す)。
    //   ⚠**コメントを取り除いてから**見る。経緯をコメントに書き残せるようにしつつ、
    //   文字列リテラルだけでなく **JSX の素のテキスト**も取りこぼさない。
    expect(stripComments(pageSrc)).not.toMatch(/OCR/i);
    expect(pageSrc).toMatch(/テキストを貼り付けるモード/);
  });

  it("parse レスポンスから extractionSource / isLikelyScanned を受け取る", () => {
    expect(pageSrc).toMatch(/extractionSource/);
    expect(pageSrc).toMatch(/isLikelyScanned/);
  });

  it("OCR や外部 OCR ライブラリを import していない", () => {
    expect(pageSrc).not.toMatch(/from\s+("|')tesseract/);
    expect(pageSrc).not.toMatch(/from\s+("|')pdf2pic/);
    expect(pageSrc).not.toMatch(/google[-_.]?cloud.*document/i);
    expect(pageSrc).not.toMatch(/azure.*form.?recognizer/i);
  });
});
