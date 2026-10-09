import { describe, it, expect, vi } from "vitest";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import {
  compressPdf,
  parseScriptOutput,
  runExclusive,
  tryReserveCompressionSlot,
  MAX_COMPRESSION_SLOTS,
  type RunDeps,
} from "../run";
import { fitPdfToLimit, reserveLargePdfSlot } from "../fit";
import {
  compressBusyMessage,
  compressFailureMessage,
  isPdfByMimeOrName,
  pdfTooLargeToAcceptMessage,
  MAX_PDF_UPLOAD_BYTES,
} from "../policy";
import { ApiError } from "@/lib/api-helpers";

// api-helpers は next-auth まで読み込むので、ApiError だけの代わりを置く(他の単体テストと同じ)。
vi.mock("@/lib/api-helpers", () => ({
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
      public code: string,
    ) {
      super(message);
    }
  },
}));

/** スクリプトの代わり。引数から出力先を読み、決まった内容を書いて JSON を返す。 */
function fakeDeps(
  behave: (args: string[]) => Promise<{ stdout: string; stderr?: string; write?: Buffer }>,
): RunDeps & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    python: "python3",
    script: "/x/pdf-compress.py",
    exec: async (_file, args) => {
      calls.push(args);
      const r = await behave(args);
      if (r.write) await writeFile(args[2], r.write);
      return { stdout: r.stdout, stderr: r.stderr ?? "" };
    },
  };
}

const okJson = (level: string, inBytes: number, outBytes: number) =>
  JSON.stringify({ ok: true, level, inBytes, outBytes, pages: 3 });

describe("compressPdf(別プロセスでの圧縮)", () => {
  it("縮んだ PDF を返し、入力の Buffer は書き換えない・一時フォルダは消す", async () => {
    const input = Buffer.alloc(100, 1);
    let dir = "";
    const deps = fakeDeps(async (args) => {
      dir = args[1].replace(/[\\/]in\.pdf$/, "");
      expect(args.slice(3)).toEqual(["--max-bytes", "50"]);
      return { stdout: okJson("jpeg85", 100, 40), write: Buffer.alloc(40, 2) };
    });
    const r = await compressPdf(input, 50, deps);
    expect(r).toMatchObject({ ok: true, level: "jpeg85", inBytes: 100, outBytes: 40 });
    expect(input.every((b) => b === 1)).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it("スクリプトの申告ではなく実物の大きさで上限を確かめる(上限超えは error)", async () => {
    const deps = fakeDeps(async () => ({ stdout: okJson("lossless", 100, 10), write: Buffer.alloc(80) }));
    const r = await compressPdf(Buffer.alloc(100), 50, deps);
    expect(r).toMatchObject({ ok: false, reason: "error" });
  });

  it("縮めきれない・暗号化・壊れた PDF は理由をそのまま返す", async () => {
    for (const reason of ["too_large", "encrypted", "invalid_pdf"] as const) {
      const deps = fakeDeps(async () => ({
        stdout: JSON.stringify({ ok: false, reason, inBytes: 100, bestBytes: reason === "too_large" ? 70 : null }),
      }));
      const r = await compressPdf(Buffer.alloc(100), 50, deps);
      expect(r).toEqual({ ok: false, reason, inBytes: 100, bestBytes: reason === "too_large" ? 70 : null });
    }
  });

  it("python が無い/pikepdf が無いときは unavailable(開発機・CI)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const noPython = fakeDeps(async () => {
      throw Object.assign(new Error("spawn"), { code: "ENOENT" });
    });
    expect(await compressPdf(Buffer.alloc(10), 5, noPython)).toMatchObject({ ok: false, reason: "unavailable" });
    const noModule = fakeDeps(async () => {
      throw Object.assign(new Error("exit 1"), { code: 1, stderr: "error=ModuleNotFoundError\n" });
    });
    expect(await compressPdf(Buffer.alloc(10), 5, noModule)).toMatchObject({ ok: false, reason: "unavailable" });
    // スクリプト先頭の import で落ちると、Python の素の Traceback になる(提出前レビュー)。
    const traceback = fakeDeps(async () => {
      throw Object.assign(new Error("exit 1"), {
        code: 1,
        stderr: "Traceback (most recent call last):\n  ...\nModuleNotFoundError: No module named 'pikepdf'\n",
      });
    });
    expect(await compressPdf(Buffer.alloc(10), 5, traceback)).toMatchObject({ ok: false, reason: "unavailable" });
    errSpy.mockRestore();
  });

  it("時間切れ・異常終了・形の違う出力は error(一時フォルダは消す)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let dir = "";
    const killed = fakeDeps(async (args) => {
      dir = args[1].replace(/[\\/]in\.pdf$/, "");
      throw Object.assign(new Error("killed"), { killed: true, signal: "SIGKILL" });
    });
    expect(await compressPdf(Buffer.alloc(10), 5, killed)).toMatchObject({ ok: false, reason: "error" });
    expect(existsSync(dir)).toBe(false);
    const garbage = fakeDeps(async () => ({ stdout: "not json" }));
    expect(await compressPdf(Buffer.alloc(10), 5, garbage)).toMatchObject({ ok: false, reason: "error" });
    errSpy.mockRestore();
  });

  it("同時に呼ばれても1本ずつ動く", async () => {
    let running = 0;
    let maxRunning = 0;
    const deps = fakeDeps(async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      return { stdout: okJson("lossless", 10, 4), write: Buffer.alloc(4) };
    });
    const rs = await Promise.all([1, 2, 3].map(() => compressPdf(Buffer.alloc(10), 5, deps)));
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(maxRunning).toBe(1);
  });

  it("runExclusive(大きいPDFの読み取り)と圧縮は同じ順番待ちで、同時に動かない", async () => {
    let running = 0;
    let maxRunning = 0;
    const work = async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
    };
    const deps = fakeDeps(async () => {
      await work();
      return { stdout: okJson("lossless", 10, 4), write: Buffer.alloc(4) };
    });
    await Promise.all([runExclusive(work), compressPdf(Buffer.alloc(10), 5, deps), runExclusive(work)]);
    expect(maxRunning).toBe(1);
  });

  it("前の呼び出しが失敗しても、次の呼び出しは動く", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = fakeDeps(async () => {
      throw new Error("boom");
    });
    const good = fakeDeps(async () => ({ stdout: okJson("lossless", 10, 4), write: Buffer.alloc(4) }));
    const [a, b] = await Promise.all([compressPdf(Buffer.alloc(10), 5, bad), compressPdf(Buffer.alloc(10), 5, good)]);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(true);
    errSpy.mockRestore();
  });
});

describe("圧縮の席(@codex PR#498 P1・待ち列に上限)", () => {
  it("動いている1本+待ち1本まで。3本目は取れない。返せばまた取れる・二重に返しても1回分", () => {
    const a = tryReserveCompressionSlot();
    const b = tryReserveCompressionSlot();
    expect(MAX_COMPRESSION_SLOTS).toBe(2);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(tryReserveCompressionSlot()).toBeNull();
    a!();
    a!();
    const c = tryReserveCompressionSlot();
    expect(c).not.toBeNull();
    expect(tryReserveCompressionSlot()).toBeNull();
    b!();
    c!();
  });

  const reqWith = (len: string | null) => ({ headers: { get: () => len } });

  it("申告が上限(8MB)以下なら席を取らない(ファイルが上限を超えることは無い)", () => {
    const reserve = vi.fn(() => () => {});
    reserveLargePdfSlot(reqWith(String(8 * 1024 * 1024)), reserve);
    reserveLargePdfSlot(reqWith(null), reserve);
    expect(reserve).not.toHaveBeenCalled();
  });

  it("★8.1〜8.9MB の PDF の送信(上限+上乗せ分以下)でも席を取る(@codex PR#498 2巡目)", () => {
    const reserve = vi.fn(() => () => {});
    reserveLargePdfSlot(reqWith(String(8 * 1024 * 1024 + 1)), reserve);
    reserveLargePdfSlot(reqWith(String(Math.floor(8.5 * 1024 * 1024))), reserve);
    expect(reserve).toHaveBeenCalledTimes(2);
  });

  it("大きい申告なら席を取り、取れなければ 503", () => {
    const release = () => {};
    expect(reserveLargePdfSlot(reqWith(String(20 * 1024 * 1024)), () => release)).toBe(release);
    const err = (() => {
      try {
        reserveLargePdfSlot(reqWith(String(20 * 1024 * 1024)), () => null);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(503);
    expect((err as ApiError).message).toBe(compressBusyMessage());
  });
});

describe("isPdfByMimeOrName", () => {
  it("MIME が PDF、または MIME が空・不明で拡張子 .pdf のときだけ PDF", () => {
    expect(isPdfByMimeOrName("application/pdf", "a.bin")).toBe(true);
    expect(isPdfByMimeOrName("", "A.PDF")).toBe(true);
    expect(isPdfByMimeOrName("application/octet-stream", "a.pdf")).toBe(true);
    expect(isPdfByMimeOrName("image/png", "a.pdf")).toBe(false);
    expect(isPdfByMimeOrName("", "a.xlsx")).toBe(false);
  });
});

describe("parseScriptOutput", () => {
  it("最後の1行の JSON だけを読み、知らない段階・理由は null", () => {
    expect(parseScriptOutput(`warn\n${okJson("jpeg75", 9, 3)}\n`)).toEqual({ ok: true, level: "jpeg75", inBytes: 9, outBytes: 3 });
    expect(parseScriptOutput(okJson("jpeg10", 9, 3))).toBeNull();
    expect(parseScriptOutput(JSON.stringify({ ok: false, reason: "boom", inBytes: 1 }))).toBeNull();
    expect(parseScriptOutput("")).toBeNull();
  });
});

describe("fitPdfToLimit(入口から使う)", () => {
  it("★上限以下の PDF には手を触れない(スクリプトを呼ばない)", async () => {
    const deps = fakeDeps(async () => ({ stdout: "" }));
    const buf = Buffer.alloc(8);
    const r = await fitPdfToLimit(buf, { limitBytes: 8, deps });
    expect(r).toEqual({ buffer: buf, originalSize: null, level: null });
    expect(deps.calls).toHaveLength(0);
  });

  it("上限を超えたら縮め、圧縮前の大きさを返す", async () => {
    const deps = fakeDeps(async () => ({ stdout: okJson("lossless", 20, 6), write: Buffer.alloc(6) }));
    const r = await fitPdfToLimit(Buffer.alloc(20), { limitBytes: 8, deps });
    expect(r.buffer.length).toBe(6);
    expect(r.originalSize).toBe(20);
    expect(r.level).toBe("lossless");
  });

  it("縮められなければ 422 と理由つきの文言(黙って捨てない)", async () => {
    const deps = fakeDeps(async () => ({
      stdout: JSON.stringify({ ok: false, reason: "too_large", inBytes: 20 * 1024 * 1024, bestBytes: 9.5 * 1024 * 1024 }),
    }));
    const err = await fitPdfToLimit(Buffer.alloc(20), { limitBytes: 8, deps }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(422);
    expect((err as ApiError).message).toContain("元 20.0MB → 最小 9.5MB");
  });
});

describe("文言", () => {
  const sizes = { inBytes: 18.8 * 1024 * 1024, bestBytes: 9.1 * 1024 * 1024, limitBytes: 8 * 1024 * 1024 };
  it("縮めきれないときは元と最小の大きさ・上限を出す", () => {
    expect(compressFailureMessage("too_large", sizes)).toBe(
      "PDFを自動で圧縮しましたが、上限(8MB)まで小さくできませんでした(元 18.8MB → 最小 9.1MB)。ページを分けて保存してください。",
    );
  });
  it("暗号化・壊れた・使えないときも、上限の数字つきで案内する", () => {
    expect(compressFailureMessage("encrypted", sizes)).toContain("パスワード付き");
    expect(compressFailureMessage("invalid_pdf", sizes)).toContain("8MB以下");
    expect(compressFailureMessage("unavailable", sizes)).toContain("8MB以下");
  });
  it("受け取る上限は 50MB と案内する", () => {
    expect(MAX_PDF_UPLOAD_BYTES).toBe(50 * 1024 * 1024);
    expect(pdfTooLargeToAcceptMessage()).toBe("PDFが大きすぎます(50MBまで。8MBを超えるPDFは自動で圧縮します)");
  });
});
