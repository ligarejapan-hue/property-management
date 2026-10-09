/**
 * 大きい PDF の自動圧縮 — 実行(scripts/pdf-compress.py を別プロセスで動かす)。
 *
 * ⚠利用者が上げた PDF は**信用しない入力**。解析は別プロセスで行い、
 *   ・時間の上限(TIMEOUT_MS)を過ぎたら止める
 *   ・メモリの上限はスクリプト側(RLIMIT_AS)
 *   ・一時ファイルはこの処理専用のフォルダ(0700)に置き、成否に関係なく必ず消す
 *   ・同時に動かすのは1本だけ(大きい PDF が重なってメモリを食わないように)
 * ⚠部品が無い環境(開発機・CI)では "unavailable" を返す=従来どおり 8MB で断る。
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PdfCompressFailure } from "./policy";

export type PdfCompressLevel = "lossless" | "jpeg85" | "jpeg75";

export type PdfCompressResult =
  | { ok: true; buffer: Buffer; level: PdfCompressLevel; inBytes: number; outBytes: number }
  | { ok: false; reason: PdfCompressFailure; inBytes: number; bestBytes: number | null };

/** 18.8MB で実測 7〜10 秒。余裕をみて 2 分。 */
export const TIMEOUT_MS = 120_000;

export interface RunDeps {
  /** スクリプトを動かす(テストでは差し替える)。 */
  exec: (
    file: string,
    args: string[],
    opts: { timeout: number },
  ) => Promise<{ stdout: string; stderr: string }>;
  python: string;
  script: string;
}

const defaultDeps: RunDeps = {
  exec: (file, args, opts) =>
    new Promise((resolve, reject) => {
      execFile(
        file,
        args,
        { timeout: opts.timeout, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) {
            Object.assign(err, { stdout: String(stdout), stderr: String(stderr) });
            reject(err);
          } else {
            resolve({ stdout: String(stdout), stderr: String(stderr) });
          }
        },
      );
    }),
  python: process.env.PDF_COMPRESS_PYTHON || "python3",
  script: path.join(process.cwd(), "scripts", "pdf-compress.py"),
};

/**
 * 圧縮の「席」: 動いている1本 + 待っている1本まで(@codex PR#498 P1)。
 * ⚠列に上限が無いと、大きい PDF が一度に来たとき、待っている分の本文(最大 50MB ずつ)まで
 *   メモリに抱えたまま何分も待たせることになる。入口は**本文を読む前に**席を取り、
 *   取れなければすぐ断る(fit.ts の reserveLargePdfSlot)。
 */
export const MAX_COMPRESSION_SLOTS = 2;
let slotsInUse = 0;

/** 席を1つ取る。取れなければ null。返した関数で必ず返す(何度呼んでも1回だけ返す)。 */
export function tryReserveCompressionSlot(): (() => void) | null {
  if (slotsInUse >= MAX_COMPRESSION_SLOTS) return null;
  slotsInUse++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    slotsInUse--;
  };
}

// 同時に1本だけ。
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

const LEVELS: readonly PdfCompressLevel[] = ["lossless", "jpeg85", "jpeg75"];
const REASONS: readonly PdfCompressFailure[] = ["too_large", "encrypted", "invalid_pdf"];

/** スクリプトの1行 JSON を読む。形が違えば null(=error 扱い)。 */
export function parseScriptOutput(
  stdout: string,
):
  | { ok: true; level: PdfCompressLevel; inBytes: number; outBytes: number }
  | { ok: false; reason: PdfCompressFailure; inBytes: number; bestBytes: number | null }
  | null {
  const line = stdout.trim().split(/\r?\n/).pop() ?? "";
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.inBytes !== "number") return null;
  if (o.ok === true) {
    if (!LEVELS.includes(o.level as PdfCompressLevel) || typeof o.outBytes !== "number") return null;
    return { ok: true, level: o.level as PdfCompressLevel, inBytes: o.inBytes, outBytes: o.outBytes };
  }
  if (o.ok === false && REASONS.includes(o.reason as PdfCompressFailure)) {
    return {
      ok: false,
      reason: o.reason as PdfCompressFailure,
      inBytes: o.inBytes,
      bestBytes: typeof o.bestBytes === "number" ? o.bestBytes : null,
    };
  }
  return null;
}

/** 部品が入っていない(python が無い・pikepdf が無い)ことを示す失敗か。 */
function isUnavailable(err: unknown): boolean {
  const e = err as { code?: unknown; stderr?: unknown };
  if (e?.code === "ENOENT") return true;
  // ⚠スクリプトは import を先頭で行うので、部品が無いと「error=…」ではなく
  //   Python の素の Traceback(…ModuleNotFoundError: …)になる。どちらでも拾う。
  return typeof e?.stderr === "string" && /\b(ModuleNotFoundError|ImportError)\b/.test(e.stderr);
}

/**
 * PDF を上限以下に縮める。入力の Buffer は書き換えない。
 * ⚠呼び出し側は「上限を超えた PDF」でだけ呼ぶこと(上限以下には手を触れない決まり)。
 */
export function compressPdf(
  input: Buffer,
  maxBytes: number,
  deps: RunDeps = defaultDeps,
): Promise<PdfCompressResult> {
  return serialize(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pm-pdfc-"));
    try {
      const src = path.join(dir, "in.pdf");
      const dst = path.join(dir, "out.pdf");
      await writeFile(src, input, { mode: 0o600 });
      let stdout: string;
      try {
        ({ stdout } = await deps.exec(
          deps.python,
          [deps.script, src, dst, "--max-bytes", String(maxBytes)],
          { timeout: TIMEOUT_MS },
        ));
      } catch (err) {
        const reason: PdfCompressFailure = isUnavailable(err) ? "unavailable" : "error";
        // 運用で気づけるよう種類だけ残す(パス・中身は出さない)。
        console.error(`[pdf-compress] ${reason}`, (err as { code?: unknown })?.code ?? "");
        return { ok: false, reason, inBytes: input.length, bestBytes: null };
      }
      const parsed = parseScriptOutput(stdout);
      if (parsed === null) {
        console.error("[pdf-compress] error unexpected-output");
        return { ok: false, reason: "error", inBytes: input.length, bestBytes: null };
      }
      if (!parsed.ok) return parsed;
      const buffer = await readFile(dst);
      // スクリプトの申告ではなく、実物の大きさで上限を確かめる。
      if (buffer.length > maxBytes || buffer.length === 0) {
        return { ok: false, reason: "error", inBytes: input.length, bestBytes: null };
      }
      return { ok: true, buffer, level: parsed.level, inBytes: input.length, outBytes: buffer.length };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
