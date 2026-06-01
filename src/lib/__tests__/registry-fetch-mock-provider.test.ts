/**
 * PR3: 謄本自動取得 provider 抽象 + mock provider を検証する。
 *
 * - mock が pdfBuffer(Buffer)/fileName/source/fetchedAt/providerRequestId を返す。
 * - mock は外部 HTTP/ブラウザ/FS/認証情報/env に依存しない（import/コードで固定）。
 * - RegistryFetchError は分類コードと固定の安全メッセージのみを持ち、PII/認証情報を載せない。
 * - 型・関数が将来の自動取得 API から provider 注入で利用できる形である。
 *
 * 本 PR では自動取得 API route / UI / 実 provider / env / Playwright / 課金は含まない。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  MockRegistryFetchProvider,
  RegistryFetchError,
  REGISTRY_FETCH_ERROR_MESSAGES,
  type RegistryFetchProvider,
  type RegistryFetchErrorCode,
} from "@/lib/registry-fetch";

const read = (p: string) =>
  fs.readFileSync(path.resolve(process.cwd(), p), "utf8");

const SRC_FILES = [
  "src/lib/registry-fetch/types.ts",
  "src/lib/registry-fetch/errors.ts",
  "src/lib/registry-fetch/mock-provider.ts",
  "src/lib/registry-fetch/index.ts",
];

const ALL_CODES: RegistryFetchErrorCode[] = [
  "timeout",
  "rate_limited",
  "auth_failed",
  "not_found",
  "provider_error",
];

// 認証情報 / 生レスポンス / PII を表す禁止語（メッセージ値に含めてはならない）。
const FORBIDDEN =
  /credential|token|apikey|api[_-]?key|password|passwd|secret|bearer|owner|address|住所|所有者|raw[_-]?response/i;

describe("PR3: MockRegistryFetchProvider の戻り値", () => {
  it("1. pdfBuffer(Buffer) + fileName/source/fetchedAt/providerRequestId を返す", async () => {
    const provider = new MockRegistryFetchProvider();
    const res = await provider.fetchRegistryPdf({
      realEstateNumber: "1234567890123",
      ref: "prop-1",
    });
    expect(Buffer.isBuffer(res.pdfBuffer)).toBe(true);
    expect(res.pdfBuffer.length).toBeGreaterThan(0);
    expect(typeof res.fileName).toBe("string");
    expect(res.fileName).toMatch(/\.pdf$/);
    expect(res.source).toBe("mock");
    expect(res.fetchedAt).toBeInstanceOf(Date);
    expect(typeof res.providerRequestId).toBe("string");
    expect(res.providerRequestId.length).toBeGreaterThan(0);
  });

  it("注入した pdfBuffer / fileName / now / providerRequestId をそのまま返す", async () => {
    const buf = Buffer.from("custom-pdf-bytes");
    const provider = new MockRegistryFetchProvider({
      pdfBuffer: buf,
      fileName: "custom.pdf",
      source: "mock",
      now: new Date(0),
      providerRequestId: "req-123",
    });
    const res = await provider.fetchRegistryPdf({ ref: "p" });
    expect(res.pdfBuffer).toBe(buf);
    expect(res.fileName).toBe("custom.pdf");
    expect(res.fetchedAt.getTime()).toBe(0);
    expect(res.providerRequestId).toBe("req-123");
  });
});

describe("PR3: mock は外部 I/O に依存しない", () => {
  it("2. http/https/net/fs/child_process/playwright 等を import していない & process.env 不参照", () => {
    for (const f of SRC_FILES) {
      const src = read(f);
      // Node 組み込みの外部 I/O モジュール
      expect(src).not.toMatch(
        /from\s+["'](node:)?(http|https|net|fs|child_process|dns|tls|dgram)["']/,
      );
      // 外部 HTTP / ブラウザ自動化ライブラリ
      expect(src).not.toMatch(
        /from\s+["'](axios|node-fetch|undici|got|playwright|puppeteer|@playwright\/test)["']/,
      );
      // ネットワーク呼び出し / 環境変数 / API キー
      expect(src).not.toMatch(/\bfetch\s*\(/);
      expect(src).not.toMatch(/process\.env/);
      expect(src).not.toMatch(/REGISTRY_API_KEY|REGISTRY_API_URL/);
    }
  });
});

describe("PR3: RegistryFetchError は安全なコード/メッセージのみ", () => {
  it("3. 各コードで固定の安全メッセージ + code を持つ Error である", () => {
    for (const code of ALL_CODES) {
      const err = new RegistryFetchError(code);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("RegistryFetchError");
      expect(err.code).toBe(code);
      expect(err.message).toBe(REGISTRY_FETCH_ERROR_MESSAGES[code]);
      expect(err.message.length).toBeGreaterThan(0);
    }
  });

  it("4. credential/token/apiKey/raw response/owner/address を含めない", () => {
    for (const code of ALL_CODES) {
      const err = new RegistryFetchError(code);
      // 列挙可能な own プロパティは code / name のみ（message は Error 既定で非列挙）
      expect(Object.keys(err).sort()).toEqual(["code", "name"]);
      expect(err.message).not.toMatch(FORBIDDEN);
      const serialized = JSON.stringify({
        name: err.name,
        code: err.code,
        message: err.message,
      });
      expect(serialized).not.toMatch(FORBIDDEN);
    }
    // 固定メッセージ定義の各値にも禁止語が無い
    for (const code of ALL_CODES) {
      expect(REGISTRY_FETCH_ERROR_MESSAGES[code]).not.toMatch(FORBIDDEN);
    }
  });

  it("RegistryFetchError は自由メッセージ引数を取らない（コードのみ）", () => {
    // 誤って外部詳細/PII を例外に載せられないよう constructor は code 引数のみ。
    expect(read("src/lib/registry-fetch/errors.ts")).toMatch(
      /constructor\(code: RegistryFetchErrorCode\)/,
    );
  });
});

describe("PR3: 将来 API から注入利用できる", () => {
  it("5. MockRegistryFetchProvider は RegistryFetchProvider を満たし注入できる", async () => {
    // 将来の API が provider: RegistryFetchProvider を受け取り呼ぶ形を模す。
    async function callWithInjectedProvider(provider: RegistryFetchProvider) {
      return provider.fetchRegistryPdf({ realEstateNumber: "1", ref: "r" });
    }
    const provider: RegistryFetchProvider = new MockRegistryFetchProvider();
    expect(provider.name).toBe("mock");
    const res = await callWithInjectedProvider(provider);
    expect(Buffer.isBuffer(res.pdfBuffer)).toBe(true);
  });

  it("failWith で RegistryFetchError 経路（rate_limited 等）を検証できる", async () => {
    const provider = new MockRegistryFetchProvider({ failWith: "rate_limited" });
    await expect(
      provider.fetchRegistryPdf({ ref: "r" }),
    ).rejects.toBeInstanceOf(RegistryFetchError);
    await expect(
      provider.fetchRegistryPdf({ ref: "r" }),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });
});

describe("PR3: スコープ限定（API route / UI / env なし）", () => {
  it("6. registry-fetch 配下に API route / UI / env / Playwright が無い", () => {
    for (const f of SRC_FILES) {
      const src = read(f);
      expect(src).not.toMatch(
        /NextRequest|NextResponse|apiResponse|export async function (GET|POST|PUT|DELETE)/,
      );
      expect(src).not.toMatch(/from\s+["'](next\/server|playwright|puppeteer)["']/);
      expect(src).not.toMatch(/process\.env/);
    }
  });
});
