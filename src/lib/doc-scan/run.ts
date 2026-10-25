/**
 * 書類を撮る — 撮った画像を1つの PDF にまとめ、先頭ページの文字を読む(scripts/doc-scan.py を別プロセスで)。
 *
 * ⚠端末から来た画像は**信用しない入力**。解析は別プロセスで、時間の上限つき・メモリの上限はスクリプト側。
 *   一時ファイルはこの処理専用のフォルダ(0700)に置き、成否に関係なく必ず消す。
 * ⚠重い処理なので、大きい PDF の圧縮と**同じ順番待ち**(runExclusive)で1本ずつ動かす。
 * ⚠読み取った文字は判別に使うだけ。保存しない・ログに出さない。
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runExclusive } from "@/lib/pdf-compress/run";
import { MAX_SCAN_PAGES } from "./pages";

/** 30ページ・先頭2ページの読み取りで実測は数秒。余裕をみて 2 分。 */
export const SCAN_TIMEOUT_MS = 120_000;

/** 判別に読むのは先頭のページだけ(1〜2ページで種類は決まる)。 */
export const OCR_PAGES = 2;

export type ScanFailure = "unavailable" | "invalid_image" | "too_many_pages" | "error";
export type OcrState = "done" | "unavailable" | "failed";

export type ScanResult =
  | { ok: true; pdf: Buffer; text: string; ocrChars: number; ocr: OcrState; pages: number }
  | { ok: false; reason: ScanFailure };

export interface ScanRunDeps {
  exec: (file: string, args: string[], opts: { timeout: number }) => Promise<{ stdout: string; stderr: string }>;
  python: string;
  script: string;
}

const defaultDeps: ScanRunDeps = {
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
  script: path.join(process.cwd(), "scripts", "doc-scan.py"),
};

const OCR_STATES: readonly OcrState[] = ["done", "unavailable", "failed"];
const SCRIPT_REASONS = ["invalid_image", "too_many_pages"] as const;

/** スクリプトの1行 JSON を読む。形が違えば null。 */
export function parseScanOutput(
  stdout: string,
):
  | { ok: true; pages: number; outBytes: number; ocrChars: number; ocr: OcrState }
  | { ok: false; reason: (typeof SCRIPT_REASONS)[number] }
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
  if (o.ok === true) {
    if (
      typeof o.pages !== "number" ||
      typeof o.outBytes !== "number" ||
      typeof o.ocrChars !== "number" ||
      !OCR_STATES.includes(o.ocr as OcrState)
    ) {
      return null;
    }
    return { ok: true, pages: o.pages, outBytes: o.outBytes, ocrChars: o.ocrChars, ocr: o.ocr as OcrState };
  }
  if (o.ok === false && SCRIPT_REASONS.includes(o.reason as (typeof SCRIPT_REASONS)[number])) {
    return { ok: false, reason: o.reason as (typeof SCRIPT_REASONS)[number] };
  }
  return null;
}

function isUnavailable(err: unknown): boolean {
  const e = err as { code?: unknown; stderr?: unknown };
  if (e?.code === "ENOENT") return true;
  return typeof e?.stderr === "string" && /\b(ModuleNotFoundError|ImportError)\b/.test(e.stderr);
}

/** 画像(1枚=1ページ・並びのまま)から PDF を作り、先頭ページの文字を読む。 */
export function buildScanPdf(pages: readonly Buffer[], deps: ScanRunDeps = defaultDeps): Promise<ScanResult> {
  if (pages.length < 1 || pages.length > MAX_SCAN_PAGES) {
    return Promise.resolve({ ok: false, reason: "too_many_pages" });
  }
  return runExclusive(async (): Promise<ScanResult> => {
    const dir = await mkdtemp(path.join(tmpdir(), "pm-scan-"));
    try {
      for (let i = 0; i < pages.length; i++) {
        await writeFile(path.join(dir, `page-${String(i).padStart(3, "0")}.img`), pages[i], { mode: 0o600 });
      }
      let stdout: string;
      try {
        ({ stdout } = await deps.exec(
          deps.python,
          [deps.script, dir, String(pages.length), "--ocr-pages", String(OCR_PAGES)],
          { timeout: SCAN_TIMEOUT_MS },
        ));
      } catch (err) {
        const reason: ScanFailure = isUnavailable(err) ? "unavailable" : "error";
        console.error(`[doc-scan] ${reason}`, (err as { code?: unknown })?.code ?? "");
        return { ok: false, reason };
      }
      const parsed = parseScanOutput(stdout);
      if (parsed === null) {
        console.error("[doc-scan] error unexpected-output");
        return { ok: false, reason: "error" };
      }
      if (!parsed.ok) return parsed;
      const pdf = await readFile(path.join(dir, "scan.pdf"));
      if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") return { ok: false, reason: "error" };
      const text = await readFile(path.join(dir, "ocr.txt"), "utf-8").catch(() => "");
      return { ok: true, pdf, text, ocrChars: parsed.ocrChars, ocr: parsed.ocr, pages: parsed.pages };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
