/**
 * 本物の scripts/pdf-compress.py を動かす(pikepdf と Pillow がある環境だけ)。
 *
 * ⚠他のテストは実行部分を差し替えているので、pikepdf の API 名の違い(本番は apt の 8.7)や
 *   JPEG への書き換えの誤りは捕まえられない(提出前レビュー)。ここで実物を通す。
 * 本番と同じ実行部分(execScript)で動かす=環境変数は許可リストだけ・閉じ込めた中で縮める。
 * 部品が無い環境(開発機・CI)では skip する。使う Python は PDF_COMPRESS_PYTHON(既定 python3)。
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compressPdf, execScript } from "../run";

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
  it("自己診断(反映後の点検と同じ)が、閉じ込めた中で縮められ、外に出られないことを示す", () => {
    const stdout = execFileSync(PYTHON, [path.join(process.cwd(), "scripts", "pdf-compress.py"), "--self-test"], {
      timeout: 120_000,
    }).toString();
    expect(JSON.parse(stdout.trim().split("\n").pop() ?? "")).toMatchObject({ selfTest: "ok", level: "jpeg85", sandbox: "ok" });
  }, 120_000);

  it("写真のような図版を JPEG にして上限以下へ縮め、ページ数を保つ", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pdfc-test-"));
    try {
      const src = path.join(dir, "in.pdf");
      execFileSync(PYTHON, ["-c", MAKE_PDF, src], { timeout: 60_000 });
      const input = readFileSync(src);
      const max = Math.floor(input.length / 3);
      const r = await compressPdf(input, max, {
        exec: execScript,
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
        exec: execScript,
        python: PYTHON,
        script: path.join(process.cwd(), "scripts", "pdf-compress.py"),
      });
      expect(r).toMatchObject({ ok: true, level: "lossless" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("目標まで縮まなくても、一番小さい形が --accept-bytes 以下ならそれを返す・超えれば too_large(2026-10-19)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pdfc-test-"));
    try {
      const src = path.join(dir, "in.pdf");
      execFileSync(PYTHON, ["-c", MAKE_PDF, src], { timeout: 60_000 });
      const input = readFileSync(src);
      const deps = {
        exec: execScript,
        python: PYTHON,
        script: path.join(process.cwd(), "scripts", "pdf-compress.py"),
      };
      // 目標を 1 バイトにして、どの段階でも届かないようにする。
      const miss = await compressPdf(input, 1, deps);
      expect(miss).toMatchObject({ ok: false, reason: "too_large" });
      if (miss.ok || miss.bestBytes === null) return;
      const hit = await compressPdf(input, 1, deps, miss.bestBytes);
      expect(hit).toMatchObject({ ok: true, outBytes: miss.bestBytes });
      const under = await compressPdf(input, 1, deps, miss.bestBytes - 1);
      expect(under).toMatchObject({ ok: false, reason: "too_large" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
});

