/**
 * まとめてある PDF を分ける — 実行(scripts/pdf-split.py を別プロセスで動かす)。
 *   ocrPageHeads: 文字の無いページの**見出しのあたり**だけを読み取る(種類を見分けるため)
 *   splitPdfByRanges: ページの範囲ごとに別の PDF にする
 *
 * ⚠利用者が上げた PDF は**信用しない入力**。別プロセス・時間の上限つき・メモリの上限はスクリプト側。
 *   一時ファイルはこの処理専用のフォルダ(0700)に置き、成否に関係なく必ず消す。
 * ⚠重い処理なので、大きい PDF の圧縮と**同じ順番待ち**(runExclusive)で1本ずつ動かす。
 *   ⚠この中から圧縮(fitPdfToLimit)を呼ばないこと=同じ列で待ち合って止まる。
 * ⚠読み取った文字は判別に使うだけ。保存しない・ログに出さない。
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runExclusive } from "@/lib/pdf-compress/run";

/**
 * 見出しの読み取りは実測 14 ページで 20 秒(1ページ 1.5 秒ほど)。上限 60 ページでも 90 秒ほど。
 * ⚠圧縮の順番待ち(前の1本 最大 120 秒)と足して、入口の待ち時間(300 秒)に収まる長さにする。
 */
export const OCR_TIMEOUT_MS = 150_000;
/** 分けるのはページを写すだけ(数秒)。 */
export const SPLIT_TIMEOUT_MS = 60_000;

export type SplitFailure = "unavailable" | "encrypted" | "invalid_pdf" | "bad_args" | "error";
export type OcrState = "done" | "unavailable" | "failed";

export interface SplitRunDeps {
  exec: (file: string, args: string[], opts: { timeout: number }) => Promise<{ stdout: string; stderr: string }>;
  python: string;
  script: string;
}

const defaultDeps: SplitRunDeps = {
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
  script: path.join(process.cwd(), "scripts", "pdf-split.py"),
};

const OCR_STATES: readonly OcrState[] = ["done", "unavailable", "failed"];
const SCRIPT_REASONS = ["encrypted", "invalid_pdf", "bad_args"] as const;
type ScriptReason = (typeof SCRIPT_REASONS)[number];

function lastJson(stdout: string): Record<string, unknown> | null {
  const line = stdout.trim().split(/\r?\n/).pop() ?? "";
  try {
    const v: unknown = JSON.parse(line);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function scriptFailure(o: Record<string, unknown>): { ok: false; reason: ScriptReason } | null {
  if (o.ok === false && SCRIPT_REASONS.includes(o.reason as ScriptReason)) {
    return { ok: false, reason: o.reason as ScriptReason };
  }
  return null;
}

/** ocr の1行 JSON を読む(読んだページの番号だけ)。形が違えば null。 */
export function parseOcrOutput(
  stdout: string,
): { ok: true; ocr: OcrState; pages: number[] } | { ok: false; reason: ScriptReason } | null {
  const o = lastJson(stdout);
  if (o === null) return null;
  if (o.ok === true) {
    if (!OCR_STATES.includes(o.ocr as OcrState) || !Array.isArray(o.pages)) return null;
    const pages: number[] = [];
    for (const p of o.pages as unknown[]) {
      const n = (p as { page?: unknown } | null)?.page;
      if (typeof n !== "number" || !Number.isInteger(n)) return null;
      pages.push(n);
    }
    return { ok: true, ocr: o.ocr as OcrState, pages };
  }
  return scriptFailure(o);
}

/** split の1行 JSON を読む(ページ数と、分けた数)。形が違えば null。 */
export function parseSplitOutput(
  stdout: string,
): { ok: true; pageCount: number; parts: number } | { ok: false; reason: ScriptReason } | null {
  const o = lastJson(stdout);
  if (o === null) return null;
  if (o.ok === true) {
    if (typeof o.pageCount !== "number" || !Array.isArray(o.parts)) return null;
    return { ok: true, pageCount: o.pageCount, parts: o.parts.length };
  }
  return scriptFailure(o);
}

function isUnavailable(err: unknown): boolean {
  const e = err as { code?: unknown; stderr?: unknown };
  if (e?.code === "ENOENT") return true;
  return typeof e?.stderr === "string" && /\b(ModuleNotFoundError|ImportError)\b/.test(e.stderr);
}

async function runScript(
  tag: string,
  deps: SplitRunDeps,
  args: (input: string, dir: string) => string[],
  timeout: number,
  pdf: Buffer,
  after: (dir: string, stdout: string) => Promise<unknown>,
): Promise<unknown> {
  const dir = await mkdtemp(path.join(tmpdir(), "pm-split-"));
  try {
    const input = path.join(dir, "in.pdf");
    await writeFile(input, pdf, { mode: 0o600 });
    let stdout: string;
    try {
      ({ stdout } = await deps.exec(deps.python, [deps.script, ...args(input, dir)], { timeout }));
    } catch (err) {
      const reason: SplitFailure = isUnavailable(err) ? "unavailable" : "error";
      // 運用で気づけるよう種類だけ残す(パス・中身は出さない)。
      console.error(`[pdf-split] ${tag} ${reason}`, (err as { code?: unknown })?.code ?? "");
      return { ok: false, reason };
    }
    return await after(dir, stdout);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export type OcrResult = { ok: true; ocr: OcrState; texts: Map<number, string> } | { ok: false; reason: SplitFailure };

/** 指定のページ(1 から数える)の見出しのあたりを読み取る。 */
export function ocrPageHeads(pdf: Buffer, pages: readonly number[], deps: SplitRunDeps = defaultDeps): Promise<OcrResult> {
  if (pages.length === 0) return Promise.resolve({ ok: true, ocr: "done", texts: new Map() });
  return runExclusive(
    () =>
      runScript(
        "ocr",
        deps,
        (input, dir) => ["ocr", input, dir, "--pages", pages.join(",")],
        OCR_TIMEOUT_MS,
        pdf,
        async (dir, stdout): Promise<OcrResult> => {
          const parsed = parseOcrOutput(stdout);
          if (parsed === null) {
            console.error("[pdf-split] ocr error unexpected-output");
            return { ok: false, reason: "error" };
          }
          if (!parsed.ok) return parsed;
          const texts = new Map<number, string>();
          for (const p of parsed.pages) {
            const name = `ocr-${String(p).padStart(3, "0")}.txt`;
            texts.set(p, await readFile(path.join(dir, name), "utf-8").catch(() => ""));
          }
          return { ok: true, ocr: parsed.ocr, texts };
        },
      ) as Promise<OcrResult>,
  );
}

export type SplitResult = { ok: true; pageCount: number; parts: Buffer[] } | { ok: false; reason: SplitFailure };

/** ページの範囲(1 から数える・両端を含む)ごとに別の PDF にする。並びは範囲の順。 */
export function splitPdfByRanges(
  pdf: Buffer,
  ranges: readonly { from: number; to: number }[],
  deps: SplitRunDeps = defaultDeps,
): Promise<SplitResult> {
  return runExclusive(
    () =>
      runScript(
        "split",
        deps,
        (input, dir) => ["split", input, dir, "--ranges", ranges.map((r) => `${r.from}-${r.to}`).join(",")],
        SPLIT_TIMEOUT_MS,
        pdf,
        async (dir, stdout): Promise<SplitResult> => {
          const parsed = parseSplitOutput(stdout);
          if (parsed === null) {
            console.error("[pdf-split] split error unexpected-output");
            return { ok: false, reason: "error" };
          }
          if (!parsed.ok) return parsed;
          if (parsed.parts !== ranges.length) return { ok: false, reason: "error" };
          const parts: Buffer[] = [];
          for (let i = 0; i < ranges.length; i++) {
            const buf = await readFile(path.join(dir, `part-${String(i).padStart(2, "0")}.pdf`)).catch(() => null);
            if (!buf || buf.subarray(0, 5).toString("latin1") !== "%PDF-") return { ok: false, reason: "error" };
            parts.push(buf);
          }
          return { ok: true, pageCount: parsed.pageCount, parts };
        },
      ) as Promise<SplitResult>,
  );
}
