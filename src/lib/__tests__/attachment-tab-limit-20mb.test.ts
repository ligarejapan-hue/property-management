/**
 * 物件の添付タブ: 保存してよい上限は 20MB(2026-10-19 発注者決定・謄本も同じ)。
 *   画面の事前チェックと案内がサーバーと同じ定数から作られていること。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = readFileSync(path.join(process.cwd(), "src/components/properties/attachment-tab.tsx"), "utf8").replace(/\r\n/g, "\n");

describe("添付タブの上限(20MB)", () => {
  it("上限はサーバーと同じ MAX_ATTACHMENT_BYTES から作る(8 の決め打ちが無い)", () => {
    expect(src).toMatch(/MAX_ATTACHMENT_BYTES/);
    expect(src).not.toMatch(/const MAX_SIZE_MB = 8;/);
  });

  it("「圧縮しています」の表示は 8MB(縮める目標)を超えたときだけ", () => {
    expect(src).toMatch(/setCompressingGeneral\(compressible && file\.size > MAX_FILE_SIZE\)/);
  });

  it("案内に 20MB まで保存できることと、8MB を超える PDF は縮めることが出る", () => {
    expect(src).toContain("hint={`上限 ${MAX_SIZE_MB}MB / PDF, Excel, CSV, Word, 画像（8MB を超えるPDFは自動で縮めます。${MAX_PDF_MB}MBまで受け付け、縮めて${MAX_SIZE_MB}MB以下になれば保存）`}");
    expect(src).toContain("hint={`PDF のみ / 上限 ${MAX_SIZE_MB}MB（縮めずにそのまま保存）`}");
  });
});
