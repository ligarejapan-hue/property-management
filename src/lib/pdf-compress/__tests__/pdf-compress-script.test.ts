/**
 * 本物の scripts/pdf-compress.py を動かす(pikepdf と Pillow がある環境だけ)。
 *
 * ⚠他のテストは実行部分を差し替えているので、pikepdf の API 名の違い(本番は apt の 8.7)や
 *   JPEG への書き換えの誤りは捕まえられない(提出前レビュー)。ここで実物を通す。
 * 部品が無い環境(開発機・CI)では skip する。使う Python は PDF_COMPRESS_PYTHON(既定 python3)。
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compressPdf } from "../run";

const PYTHON = process.env.PDF_COMPRESS_PYTHON || "python3";

function available(): boolean {
  try {
    execFileSync(PYTHON, ["-c", "import pikepdf, PIL"], { stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 試験用 PDF を作る: 4ページ・各ページに「写真のような」RGB 図版(同じ図版を2回ずつ使う)。
 * 図版は Flate(劣化なし)で入れる=実物の査定報告書と同じ形。
 */
const MAKE_PDF = [
  "import sys, random, zlib, pikepdf",
  "random.seed(1)",
  "W = H = 600",
  "def img(pdf, seed):",
  "    random.seed(seed)",
  "    rows = bytearray()",
  "    for y in range(H):",
  "        for x in range(W):",
  "            rows += bytes(((x + seed * 40) % 256, (y * 2) % 256, random.randint(0, 40)))",
  "    s = pikepdf.Stream(pdf, zlib.compress(bytes(rows)))",
  "    s.Type = pikepdf.Name.XObject; s.Subtype = pikepdf.Name.Image",
  "    s.Width = W; s.Height = H; s.ColorSpace = pikepdf.Name.DeviceRGB; s.BitsPerComponent = 8",
  "    s.Filter = pikepdf.Name.FlateDecode",
  "    return s",
  "pdf = pikepdf.new()",
  "images = [img(pdf, 1), img(pdf, 2)]",
  "for i in range(4):",
  "    page = pdf.add_blank_page(page_size=(600, 600))",
  "    page.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=images[i % 2]))",
  "    page.Contents = pdf.make_stream(b'q 600 0 0 600 0 0 cm /Im0 Do Q')",
  "pdf.save(sys.argv[1])",
].join("\n");

describe.skipIf(!available())("scripts/pdf-compress.py(実物)", () => {
  it("写真のような図版を JPEG にして上限以下へ縮め、ページ数を保つ", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pdfc-test-"));
    try {
      const src = path.join(dir, "in.pdf");
      execFileSync(PYTHON, ["-c", MAKE_PDF, src], { timeout: 60_000 });
      const input = readFileSync(src);
      const max = Math.floor(input.length / 3);
      const r = await compressPdf(input, max, {
        exec: (file, args, opts) =>
          new Promise((resolve, reject) => {
            try {
              const stdout = execFileSync(file, args, { timeout: opts.timeout }).toString();
              resolve({ stdout, stderr: "" });
            } catch (e) {
              reject(e);
            }
          }),
        python: PYTHON,
        script: path.join(process.cwd(), "scripts", "pdf-compress.py"),
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.outBytes).toBeLessThanOrEqual(max);
      expect(r.buffer.subarray(0, 5).toString()).toBe("%PDF-");
      const out = path.join(dir, "out.pdf");
      writeFileSync(out, r.buffer);
      const pages = execFileSync(PYTHON, ["-c", "import sys, pikepdf; print(len(pikepdf.open(sys.argv[1]).pages))", out])
        .toString()
        .trim();
      expect(pages).toBe("4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("上限が十分大きければ劣化なし(lossless)の段階で止まる", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pdfc-test-"));
    try {
      const src = path.join(dir, "in.pdf");
      execFileSync(PYTHON, ["-c", MAKE_PDF, src], { timeout: 60_000 });
      const input = readFileSync(src);
      const r = await compressPdf(input, input.length, {
        exec: async (file, args, opts) => ({ stdout: execFileSync(file, args, { timeout: opts.timeout }).toString(), stderr: "" }),
        python: PYTHON,
        script: path.join(process.cwd(), "scripts", "pdf-compress.py"),
      });
      expect(r).toMatchObject({ ok: true, level: "lossless" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

