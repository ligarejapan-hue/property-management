import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ocrPageHeads, parseOcrOutput, parseSplitOutput, splitPdfByRanges, type SplitRunDeps } from "../run";

function fakeDeps(
  behave: (dir: string, args: string[]) => Promise<{ stdout: string; stderr: string }>,
): SplitRunDeps & { seen: { dir: string; args: string[]; files: string[]; input: string }[] } {
  const seen: { dir: string; args: string[]; files: string[]; input: string }[] = [];
  return {
    seen,
    python: "python3",
    script: "pdf-split.py",
    exec: async (_file, args) => {
      const dir = args[3];
      seen.push({ dir, args, files: (await readdir(dir)).sort(), input: await readFile(args[2], "latin1") });
      return behave(dir, args);
    },
  };
}

const PDF = Buffer.from("%PDF-1.7 bundle");

describe("parseOcrOutput / parseSplitOutput", () => {
  it("成功の1行を読む", () => {
    expect(parseOcrOutput('{"ok":true,"ocr":"done","pages":[{"page":4,"chars":12}]}')).toEqual({
      ok: true,
      ocr: "done",
      pages: [4],
    });
    expect(parseSplitOutput('{"ok":true,"pageCount":3,"parts":[{"pages":1,"bytes":5},{"pages":2,"bytes":6}]}')).toEqual({
      ok: true,
      pageCount: 3,
      parts: 2,
    });
  });

  it("失敗の理由を読む", () => {
    expect(parseOcrOutput('{"ok":false,"reason":"encrypted"}')).toEqual({ ok: false, reason: "encrypted" });
    expect(parseSplitOutput('{"ok":false,"reason":"bad_args"}')).toEqual({ ok: false, reason: "bad_args" });
  });

  it("形が違えば null", () => {
    expect(parseOcrOutput("Traceback")).toBeNull();
    expect(parseOcrOutput('{"ok":true,"ocr":"maybe","pages":[]}')).toBeNull();
    expect(parseOcrOutput('{"ok":true,"ocr":"done","pages":[{"page":"4"}]}')).toBeNull();
    expect(parseSplitOutput('{"ok":true,"pageCount":"3","parts":[]}')).toBeNull();
    expect(parseSplitOutput('{"ok":false,"reason":"other"}')).toBeNull();
  });
});

describe("ocrPageHeads", () => {
  it("指定のページだけを読ませ、ページ番号ごとの文字を返し、作業フォルダを消す", async () => {
    const deps = fakeDeps(async (dir) => {
      await writeFile(path.join(dir, "ocr-004.txt"), "仕上表", "utf-8");
      await writeFile(path.join(dir, "ocr-014.txt"), "全部事項証明書", "utf-8");
      return { stdout: '{"ok":true,"ocr":"done","pages":[{"page":4,"chars":3},{"page":14,"chars":7}]}', stderr: "" };
    });
    const r = await ocrPageHeads(PDF, [4, 14], deps);
    expect(r).toEqual({ ok: true, ocr: "done", texts: new Map([[4, "仕上表"], [14, "全部事項証明書"]]) });
    expect(deps.seen[0].args.slice(0, 2)).toEqual(["pdf-split.py", "ocr"]);
    expect(deps.seen[0].args.slice(4)).toEqual(["--pages", "4,14"]);
    expect(deps.seen[0].input).toBe("%PDF-1.7 bundle");
    await expect(readdir(deps.seen[0].dir)).rejects.toThrow();
  });

  it("読むページが無ければスクリプトを呼ばない", async () => {
    const deps = fakeDeps(async () => {
      throw new Error("呼ばれない");
    });
    expect(await ocrPageHeads(PDF, [], deps)).toEqual({ ok: true, ocr: "done", texts: new Map() });
    expect(deps.seen).toHaveLength(0);
  });

  it("部品が無い環境は unavailable", async () => {
    const deps = fakeDeps(async () => {
      throw Object.assign(new Error("x"), { code: "ENOENT" });
    });
    expect(await ocrPageHeads(PDF, [1], deps)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("鍵のかかった PDF は encrypted", async () => {
    const deps = fakeDeps(async () => ({ stdout: '{"ok":false,"reason":"encrypted"}', stderr: "" }));
    expect(await ocrPageHeads(PDF, [1], deps)).toEqual({ ok: false, reason: "encrypted" });
  });
});

describe("splitPdfByRanges", () => {
  it("範囲を渡して分け、分けた PDF を順に返し、作業フォルダを消す", async () => {
    const deps = fakeDeps(async (dir) => {
      await writeFile(path.join(dir, "part-00.pdf"), "%PDF-a");
      await writeFile(path.join(dir, "part-01.pdf"), "%PDF-b");
      return { stdout: '{"ok":true,"pageCount":3,"parts":[{"pages":1,"bytes":6},{"pages":2,"bytes":6}]}', stderr: "" };
    });
    const r = await splitPdfByRanges(PDF, [{ from: 1, to: 1 }, { from: 2, to: 3 }], deps);
    expect(r).toEqual({ ok: true, pageCount: 3, parts: [Buffer.from("%PDF-a"), Buffer.from("%PDF-b")] });
    expect(deps.seen[0].args.slice(0, 2)).toEqual(["pdf-split.py", "split"]);
    expect(deps.seen[0].args.slice(4)).toEqual(["--ranges", "1-1,2-3"]);
    await expect(readdir(deps.seen[0].dir)).rejects.toThrow();
  });

  it("分けた数が範囲の数と違えば error", async () => {
    const deps = fakeDeps(async (dir) => {
      await writeFile(path.join(dir, "part-00.pdf"), "%PDF-a");
      return { stdout: '{"ok":true,"pageCount":3,"parts":[{"pages":1,"bytes":6}]}', stderr: "" };
    });
    expect(await splitPdfByRanges(PDF, [{ from: 1, to: 1 }, { from: 2, to: 3 }], deps)).toEqual({ ok: false, reason: "error" });
  });

  it("出来たものが PDF でなければ error", async () => {
    const deps = fakeDeps(async (dir) => {
      await writeFile(path.join(dir, "part-00.pdf"), "nope");
      await writeFile(path.join(dir, "part-01.pdf"), "%PDF-b");
      return { stdout: '{"ok":true,"pageCount":2,"parts":[{"pages":1,"bytes":4},{"pages":1,"bytes":6}]}', stderr: "" };
    });
    expect(await splitPdfByRanges(PDF, [{ from: 1, to: 1 }, { from: 2, to: 2 }], deps)).toEqual({ ok: false, reason: "error" });
  });

  it("範囲がページ数を超えていれば bad_args", async () => {
    const deps = fakeDeps(async () => ({ stdout: '{"ok":false,"reason":"bad_args"}', stderr: "" }));
    expect(await splitPdfByRanges(PDF, [{ from: 1, to: 9 }], deps)).toEqual({ ok: false, reason: "bad_args" });
  });
});
