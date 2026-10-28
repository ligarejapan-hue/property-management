/**
 * 本物の scripts/pdf-split.py の split を動かす(pikepdf がある環境だけ)。
 * ⚠他のテストは実行部分を差し替えているので、pikepdf の API 名の違い(本番は apt の 8.7)は捕まえられない。
 * 部品が無い環境(開発機・CI)では skip する。使う Python は PDF_COMPRESS_PYTHON(既定 python3)。
 * ⚠見出しの読み取り(ocr)は Tesseract と pdftoppm が要るので、本番のサーバーで実物を通して確かめた
 *   (2026-10-28・18ページの物件概要書=14ページを20秒で読み、7つに分けられた)。
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PYTHON = process.env.PDF_COMPRESS_PYTHON || "python3";
const SCRIPT = path.join(process.cwd(), "scripts", "pdf-split.py");

function available(): boolean {
  try {
    execFileSync(PYTHON, ["-c", "import pikepdf, PIL"], { stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

const MAKE_PDF = [
  "import sys, pikepdf",
  "pdf = pikepdf.new()",
  "for i in range(3):",
  "    pdf.add_blank_page(page_size=(595, 842))",
  "pdf.save(sys.argv[1])",
].join("\n");

const COUNT = ["import sys, pikepdf", "print(len(pikepdf.open(sys.argv[1]).pages))"].join("\n");

const run = (args: string[]) => JSON.parse(execFileSync(PYTHON, [SCRIPT, ...args], { timeout: 60_000 }).toString().trim());

describe.skipIf(!available())("scripts/pdf-split.py split(実物)", () => {
  it("範囲ごとに分け、ページ数と分けた数を返す", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pm-split-test-"));
    try {
      const input = path.join(dir, "in.pdf");
      execFileSync(PYTHON, ["-c", MAKE_PDF, input]);
      const out = run(["split", input, dir, "--ranges", "1-1,2-3"]);
      expect(out.ok).toBe(true);
      expect(out.pageCount).toBe(3);
      expect(out.parts.map((p: { pages: number }) => p.pages)).toEqual([1, 2]);
      const count = (f: string) => Number(execFileSync(PYTHON, ["-c", COUNT, path.join(dir, f)]).toString().trim());
      expect(count("part-00.pdf")).toBe(1);
      expect(count("part-01.pdf")).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("範囲がページ数を超えていれば bad_args", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pm-split-test-"));
    try {
      const input = path.join(dir, "in.pdf");
      execFileSync(PYTHON, ["-c", MAKE_PDF, input]);
      expect(run(["split", input, dir, "--ranges", "1-4"])).toEqual({ ok: false, reason: "bad_args" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("PDF でなければ invalid_pdf", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pm-split-test-"));
    try {
      const input = path.join(dir, "in.pdf");
      writeFileSync(input, "not a pdf");
      expect(run(["split", input, dir, "--ranges", "1-1"])).toEqual({ ok: false, reason: "invalid_pdf" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
