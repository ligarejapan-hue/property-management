/**
 * 圧縮の処理を閉じ込める(2026-11-06 発注者・お客様のファイルも縮めるようになったため)。
 *  1. 渡す環境変数は許可リストだけ(app.env の DATABASE_URL・合言葉は渡さない)
 *  2. 読み書きはその回の作業フォルダだけ(scripts/pdf_sandbox.py・Linux の Landlock)
 *  3. 時間の上限: 社内の添付は 2 分のまま・お客様のファイルは 60 秒(fit-pdf.ts)
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compressPdf, execScript, scriptEnv, TIMEOUT_MS, type RunDeps } from "../run";
import { fitPdfToLimit } from "../fit";

vi.mock("@/lib/api-helpers", () => ({
  ApiError: class ApiError extends Error {},
}));

const SECRETS = {
  DATABASE_URL: "postgresql://pm:secret-db-pass@127.0.0.1/pm",
  DEAL_DOC_LINK_SECRET: "secret-doc-link",
  NEXTAUTH_SECRET: "secret-nextauth",
};
const ALLOWED_KEYS = ["HOME", "LANG", "LC_ALL", "PATH", "PYTHONDONTWRITEBYTECODE", "PYTHONNOUSERSITE", "TMPDIR"];

afterEach(() => {
  vi.unstubAllEnvs();
});

type Seen = { args: string[]; opts: { timeout: number; env: Record<string, string> } };
function recordingDeps(seen: Seen[]): RunDeps {
  return {
    python: "python3",
    script: "/x/pdf-compress.py",
    exec: async (_file, args, opts) => {
      seen.push({ args, opts });
      await writeFile(args[2], Buffer.alloc(4, 2));
      return { stdout: JSON.stringify({ ok: true, level: "lossless", inBytes: 10, outBytes: 4 }), stderr: "" };
    },
  };
}

describe("圧縮の処理に渡す環境変数は許可リストだけ", () => {
  it("app.env の秘密(DATABASE_URL・DEAL_DOC_LINK_SECRET など)は渡さない・HOME と TMPDIR はその回の作業フォルダ", async () => {
    for (const [k, v] of Object.entries(SECRETS)) vi.stubEnv(k, v);
    const seen: Seen[] = [];
    const r = await compressPdf(Buffer.alloc(10), 5, recordingDeps(seen));
    expect(r.ok).toBe(true);
    const { args, opts } = seen[0];
    expect(Object.keys(opts.env).sort()).toEqual(ALLOWED_KEYS);
    const values = Object.values(opts.env).join("\n");
    for (const v of Object.values(SECRETS)) expect(values).not.toContain(v);
    const workDir = path.dirname(args[1]);
    expect(opts.env.HOME).toBe(workDir);
    expect(opts.env.TMPDIR).toBe(workDir);
    expect(path.dirname(args[2])).toBe(workDir);
  });

  it("scriptEnv は元の環境に何があっても許可リストの外を足さない", () => {
    const env = scriptEnv("/w", { ...SECRETS, PATH: "/usr/bin:/bin", PYTHONPATH: "/evil", LD_PRELOAD: "/evil.so" });
    expect(Object.keys(env).sort()).toEqual(ALLOWED_KEYS);
    expect(env.PATH).toBe("/usr/bin:/bin");
  });

  it("実際に別プロセスを動かしても、秘密は子の環境に届かない(既定の実行部分が env を渡している)", async () => {
    for (const [k, v] of Object.entries(SECRETS)) vi.stubEnv(k, v);
    const dir = mkdtempSync(path.join(tmpdir(), "pdfc-env-"));
    try {
      const { stdout } = await execScript(
        process.execPath,
        ["-e", "process.stdout.write(JSON.stringify(process.env))"],
        { timeout: 30_000, env: scriptEnv(dir) },
      );
      const childEnv = JSON.parse(stdout) as Record<string, string>;
      for (const k of Object.keys(SECRETS)) expect(childEnv[k]).toBeUndefined();
      expect(stdout).not.toContain("secret-");
      expect(childEnv.TMPDIR).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("時間の上限: 社内の添付は 2 分・お客様のファイルは呼び出し側が短くできる", () => {
  it("既定(社内の添付の fitPdfToLimit)は 2 分", async () => {
    const seen: Seen[] = [];
    await fitPdfToLimit(Buffer.alloc(10), { limitBytes: 5, deps: recordingDeps(seen) });
    expect(TIMEOUT_MS).toBe(120_000);
    expect(seen[0].opts.timeout).toBe(120_000);
  });

  it("timeoutMs を渡せばその時間で止める", async () => {
    const seen: Seen[] = [];
    await compressPdf(Buffer.alloc(10), 5, recordingDeps(seen), 5, 60_000);
    expect(seen[0].opts.timeout).toBe(60_000);
  });
});

describe("scripts/pdf-compress.py は入力を開く前に閉じ込める", () => {
  const src = readFileSync(path.join(process.cwd(), "scripts", "pdf-compress.py"), "utf8").replace(/\r\n/g, "\n");
  it("main で confine を呼んでから入力の大きさを見る・開く", () => {
    const main = src.slice(src.indexOf("def main():"));
    const confineAt = main.indexOf("_confine_to(");
    expect(confineAt).toBeGreaterThan(0);
    expect(confineAt).toBeLessThan(main.indexOf("os.path.getsize(a.src)"));
    expect(confineAt).toBeLessThan(main.indexOf("pikepdf.open(a.src)"));
  });
  it("Landlock の版が 3 未満(外のファイルを空にするのを止められない)なら閉じ込めを断る", () => {
    const sandbox = readFileSync(path.join(process.cwd(), "scripts", "pdf_sandbox.py"), "utf8").replace(/\r\n/g, "\n");
    expect(sandbox).toMatch(/^_MIN_ABI = 3$/m);
    expect(sandbox).toMatch(/if abi < _MIN_ABI:\n\s+raise SandboxUnavailable/);
    expect(sandbox).toMatch(/^\s+handled = _ABI1_ALL \| _REFER \| _TRUNCATE$/m);
  });
  it("自己診断も閉じ込めた中で縮め、外に書けないことを確かめる", () => {
    const selfTest = src.slice(src.indexOf("def _self_test():"), src.indexOf("def main():"));
    expect(selfTest).toContain("_confine_to(");
    expect(selfTest).toContain('"sandbox"');
    expect(selfTest).toContain('"truncateOutside": "denied"');
  });
});

// ── 本物の閉じ込め(Linux だけ・CI の ubuntu で動く。pikepdf は要らない) ──
const PYTHON = process.env.PDF_COMPRESS_PYTHON || "python3";
function pythonAvailable(): boolean {
  try {
    execFileSync(PYTHON, ["-c", "import ctypes"], { stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.platform !== "linux" || !pythonAvailable())("scripts/pdf_sandbox.py(本物の Landlock)", () => {
  it("作業フォルダには書けて、外のファイルは読めず、外には書けない", () => {
    const work = mkdtempSync(path.join(tmpdir(), "pdfc-work-"));
    const outside = mkdtempSync(path.join(tmpdir(), "pdfc-outside-"));
    try {
      const secret = path.join(outside, "secret.txt");
      writeFileSync(secret, "do-not-read");
      const stdout = execFileSync(PYTHON, [path.join(process.cwd(), "scripts", "pdf_sandbox.py"), "--probe", work, secret], {
        timeout: 30_000,
        env: scriptEnv(work) as NodeJS.ProcessEnv,
      }).toString();
      expect(JSON.parse(stdout.trim())).toEqual({
        writeInside: "ok",
        readOutside: "denied",
        truncateOutside: "denied",
        writeOutside: "denied",
        readUsr: "ok",
      });
      expect(readFileSync(path.join(work, "probe.txt"), "utf8")).toBe("ok");
      // 外のファイルは空にされていない(Landlock の版が 3 未満なら閉じ込め自体を断る・@codex P2)。
      expect(readFileSync(secret, "utf8")).toBe("do-not-read");
      expect(existsSync(path.join(outside, "pdfc-escape-probe"))).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
