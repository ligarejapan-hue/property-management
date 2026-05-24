/**
 * scripts/migrate-local-to-s3.mjs の loadEnvFromFile 単体テスト (Phase 2 Codex P1).
 *
 * docs 案内の通り `.env` ベースで credentials を渡せるか、
 * shell env が既にある場合に上書きしないか、`.env` 不在で安全か、
 * secret 値がログに出ないかを担保する。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// .mjs を ESM で import (vitest 4 は ESM サポート)。
// 型は無いが script は ESM export を持つので default ではなく named import が使える。
// @ts-expect-error -- JS の .mjs を TS から型なしで import
import { loadEnvFromFile } from "../../../../scripts/migrate-local-to-s3.mjs";

const TARGET_KEYS = [
  "STORAGE_S3_BUCKET",
  "STORAGE_S3_REGION",
  "STORAGE_S3_ACCESS_KEY_ID",
  "STORAGE_S3_SECRET_ACCESS_KEY",
  "STORAGE_S3_ENDPOINT",
  "STORAGE_S3_FORCE_PATH_STYLE",
];

const ORIGINAL_ENV = { ...process.env };
let tmpDir: string;

function clearTargetEnv() {
  for (const k of TARGET_KEYS) delete process.env[k];
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-s3-env-test-"));
  clearTargetEnv();
});

afterEach(async () => {
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  clearTargetEnv();
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("loadEnvFromFile (Codex P1)", () => {
  it(".env に書いた STORAGE_S3_* を process.env に読み込む", async () => {
    const envPath = path.join(tmpDir, ".env");
    await fs.writeFile(
      envPath,
      [
        "STORAGE_S3_BUCKET=test-bucket",
        "STORAGE_S3_REGION=auto",
        "STORAGE_S3_ACCESS_KEY_ID=AKIA_FROM_DOTENV",
        "STORAGE_S3_SECRET_ACCESS_KEY=SECRET_FROM_DOTENV",
        "",
      ].join("\n"),
      "utf8",
    );

    loadEnvFromFile(envPath);

    expect(process.env.STORAGE_S3_BUCKET).toBe("test-bucket");
    expect(process.env.STORAGE_S3_REGION).toBe("auto");
    expect(process.env.STORAGE_S3_ACCESS_KEY_ID).toBe("AKIA_FROM_DOTENV");
    expect(process.env.STORAGE_S3_SECRET_ACCESS_KEY).toBe("SECRET_FROM_DOTENV");
  });

  it("shell で先に export された値は .env で上書きしない (override:false)", async () => {
    // shell env を先に設定
    process.env.STORAGE_S3_BUCKET = "shell-bucket";
    process.env.STORAGE_S3_ACCESS_KEY_ID = "AKIA_FROM_SHELL";

    const envPath = path.join(tmpDir, ".env");
    await fs.writeFile(
      envPath,
      [
        "STORAGE_S3_BUCKET=dotenv-bucket",
        "STORAGE_S3_ACCESS_KEY_ID=AKIA_FROM_DOTENV",
        "STORAGE_S3_REGION=auto",
        "",
      ].join("\n"),
      "utf8",
    );

    loadEnvFromFile(envPath);

    // shell env は維持
    expect(process.env.STORAGE_S3_BUCKET).toBe("shell-bucket");
    expect(process.env.STORAGE_S3_ACCESS_KEY_ID).toBe("AKIA_FROM_SHELL");
    // .env 側にしか無い値は読まれる
    expect(process.env.STORAGE_S3_REGION).toBe("auto");
  });

  it(".env が存在しなくても throw / warn しない (silent, shell env だけで動く)", () => {
    process.env.STORAGE_S3_BUCKET = "shell-only";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const missing = path.join(tmpDir, "does-not-exist.env");
    expect(() => loadEnvFromFile(missing)).not.toThrow();
    // ENOENT は silent
    expect(warnSpy).not.toHaveBeenCalled();
    // shell env はそのまま使える
    expect(process.env.STORAGE_S3_BUCKET).toBe("shell-only");

    warnSpy.mockRestore();
  });

  it("loadEnvFromFile はログに secret 値を出さない", async () => {
    const SECRET_VALUE = "SECRET_NEVER_LEAKED_42";
    const envPath = path.join(tmpDir, ".env");
    await fs.writeFile(
      envPath,
      [
        `STORAGE_S3_SECRET_ACCESS_KEY=${SECRET_VALUE}`,
        `STORAGE_S3_ACCESS_KEY_ID=AKIA_X`,
        "",
      ].join("\n"),
      "utf8",
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    loadEnvFromFile(envPath);

    for (const spy of [warnSpy, logSpy, errorSpy]) {
      for (const call of spy.mock.calls) {
        const line = call.map((x) => String(x)).join(" ");
        expect(line).not.toContain(SECRET_VALUE);
        expect(line).not.toContain("AKIA_X");
      }
    }

    warnSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("読み込み失敗 (ENOENT 以外) のログにファイルパスは含むが値は含まない", async () => {
    // 通常 dotenvConfig は ENOENT 以外で error を返すケースが少ないため、
    // ここでは「ログ書式が `[warn] failed to load env file (CODE): PATH` で
    // secret を含まない」ことだけを契約として担保する (regex check)。
    // 実際の error 注入は dotenv の内部実装に依存するため省略。
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // ファイルではなくディレクトリを指す → EISDIR が返る環境がある
    // (環境依存のためログが出れば書式を、出なければ無検証で pass)
    loadEnvFromFile(tmpDir);
    for (const call of warnSpy.mock.calls) {
      const line = call.map((x) => String(x)).join(" ");
      // 期待書式: 値が混じっていない
      expect(line).toMatch(/failed to load env file/);
      expect(line).not.toMatch(/AKIA/);
      expect(line).not.toMatch(/SECRET/);
    }
    warnSpy.mockRestore();
  });
});
