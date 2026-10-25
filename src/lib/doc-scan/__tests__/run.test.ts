import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildScanPdf, parseScanOutput, type ScanRunDeps } from "../run";

function fakeDeps(
  behave: (dir: string, args: string[]) => Promise<{ stdout: string; stderr: string }>,
): ScanRunDeps & { seen: { dir: string; files: string[] }[] } {
  const seen: { dir: string; files: string[] }[] = [];
  return {
    seen,
    python: "python3",
    script: "doc-scan.py",
    exec: async (_file, args) => {
      const dir = args[1];
      seen.push({ dir, files: (await readdir(dir)).sort() });
      return behave(dir, args);
    },
  };
}

const page = (s: string) => Buffer.from(s);

describe("parseScanOutput", () => {
  it("成功の1行を読む", () => {
    expect(parseScanOutput('{"ok":true,"pages":2,"outBytes":10,"ocrChars":5,"ocr":"done"}\n')).toEqual({
      ok: true,
      pages: 2,
      outBytes: 10,
      ocrChars: 5,
      ocr: "done",
    });
  });

  it("失敗の理由を読む", () => {
    expect(parseScanOutput('{"ok":false,"reason":"invalid_image"}')).toEqual({ ok: false, reason: "invalid_image" });
  });

  it("形が違えば null", () => {
    expect(parseScanOutput("Traceback")).toBeNull();
    expect(parseScanOutput('{"ok":true,"pages":"2"}')).toBeNull();
    expect(parseScanOutput('{"ok":false,"reason":"other"}')).toBeNull();
  });
});

describe("buildScanPdf", () => {
  it("ページを順に置いてスクリプトを呼び、PDF と読み取り文字を返し、作業フォルダを消す", async () => {
    const deps = fakeDeps(async (dir) => {
      await writeFile(path.join(dir, "scan.pdf"), "%PDF-1.4 x");
      await writeFile(path.join(dir, "ocr.txt"), "不動産売買契約書", "utf-8");
      return { stdout: '{"ok":true,"pages":2,"outBytes":10,"ocrChars":8,"ocr":"done"}', stderr: "" };
    });
    const r = await buildScanPdf([page("a"), page("b")], deps);
    expect(r).toEqual({
      ok: true,
      pdf: Buffer.from("%PDF-1.4 x"),
      text: "不動産売買契約書",
      ocrChars: 8,
      ocr: "done",
      pages: 2,
    });
    expect(deps.seen[0].files).toEqual(["page-000.img", "page-001.img"]);
    await expect(readdir(deps.seen[0].dir)).rejects.toThrow();
  });

  it("python や Pillow が無い環境は unavailable", async () => {
    const deps = fakeDeps(async () => {
      throw Object.assign(new Error("x"), { code: "ENOENT" });
    });
    expect(await buildScanPdf([page("a")], deps)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("画像として読めなければ invalid_image", async () => {
    const deps = fakeDeps(async () => ({ stdout: '{"ok":false,"reason":"invalid_image"}', stderr: "" }));
    expect(await buildScanPdf([page("a")], deps)).toEqual({ ok: false, reason: "invalid_image" });
  });

  it("出来た PDF が PDF でなければ error", async () => {
    const deps = fakeDeps(async (dir) => {
      await writeFile(path.join(dir, "scan.pdf"), "nope");
      await writeFile(path.join(dir, "ocr.txt"), "");
      return { stdout: '{"ok":true,"pages":1,"outBytes":4,"ocrChars":0,"ocr":"done"}', stderr: "" };
    });
    expect(await buildScanPdf([page("a")], deps)).toEqual({ ok: false, reason: "error" });
  });

  it("0枚・31枚はスクリプトを呼ばずに断る", async () => {
    const deps = fakeDeps(async () => ({ stdout: "", stderr: "" }));
    expect(await buildScanPdf([], deps)).toEqual({ ok: false, reason: "too_many_pages" });
    expect(await buildScanPdf(Array.from({ length: 31 }, () => page("a")), deps)).toEqual({
      ok: false,
      reason: "too_many_pages",
    });
    expect(deps.seen).toHaveLength(0);
  });
});
