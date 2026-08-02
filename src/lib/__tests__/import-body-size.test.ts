/**
 * CSV/XLSX 取込の**パース前**サイズガード（2026-08-02 監査）。
 * PDF 取込は Content-Length で事前に弾いていたのに JSON 経路は素通りだった非対称を是正。
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return { ApiError: MockApiError };
});

import {
  assertImportJsonBodySize,
  MAX_IMPORT_JSON_BODY_BYTES,
  MAX_IMPORT_JSON_BODY_BYTES_PAIRED,
} from "@/lib/import-body-size";

const req = (contentLength: string | null) => ({
  headers: { get: (n: string) => (n === "content-length" ? contentLength : null) },
});

describe("assertImportJsonBodySize", () => {
  it("上限以内は通る（10MB の CSV が base64 で膨らんでも収まる余裕）", () => {
    expect(() => assertImportJsonBodySize(req("1024"))).not.toThrow();
    expect(() =>
      assertImportJsonBodySize(req(String(MAX_IMPORT_JSON_BODY_BYTES))),
    ).not.toThrow();
    // per-file 上限(10MB)が JSON 文字列化で最悪2倍に膨らんでも通ること
    // (Codex R2 P2: ここで per-file 検証より厳しくしない)。
    expect(MAX_IMPORT_JSON_BODY_BYTES).toBeGreaterThanOrEqual(2 * 10 * 1024 * 1024);
  });

  it("Content-Length 欠落・非数値は 411（chunked でのガード回避を防ぐ）", () => {
    for (const v of [null, "", "  ", "abc", "NaN", "-1"]) {
      try {
        assertImportJsonBodySize(req(v));
        throw new Error(`should have thrown for ${String(v)}`);
      } catch (e) {
        expect((e as { status: number }).status).toBe(411);
      }
    }
  });

  it("上限超過は 413", () => {
    try {
      assertImportJsonBodySize(req(String(MAX_IMPORT_JSON_BODY_BYTES + 1)));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as { status: number; code: string }).status).toBe(413);
      expect((e as { code: string }).code).toBe("PAYLOAD_TOO_LARGE");
    }
  });
});

describe("2ファイル経路(受付帳+所有者)の上限(Codex #349 P2)", () => {
  it("1ファイル上限の2倍=正規の8MB×2(base64膨張込み)が通る", () => {
    expect(MAX_IMPORT_JSON_BODY_BYTES_PAIRED).toBe(MAX_IMPORT_JSON_BODY_BYTES * 2);
    // 2ファイルとも最悪エスケープ(各10MB→20MB)でも通ること。
    const worstCase = 2 * 2 * 10 * 1024 * 1024;
    expect(MAX_IMPORT_JSON_BODY_BYTES_PAIRED).toBeGreaterThanOrEqual(worstCase);
    expect(() =>
      assertImportJsonBodySize(req(String(worstCase)), MAX_IMPORT_JSON_BODY_BYTES_PAIRED),
    ).not.toThrow();
  });

  // ⚠2ファイル経路は受付帳+所有者の突合(reception-owner)だけ。reception-property は
  // 受付帳1本なので通常の上限を使う(Codex #349 R6 P2)。
  it.each([
    "src/app/api/import/reception-owner/route.ts",
    "src/app/api/import/reception-owner/preview/route.ts",
  ])("%s は2ファイル用の上限を渡す", (rel) => {
    const src = readFileSync(join(process.cwd(), rel), "utf-8");
    expect(src).toContain(
      "assertImportJsonBodySize(request, MAX_IMPORT_JSON_BODY_BYTES_PAIRED)",
    );
  });

  it.each([
    "src/app/api/import/reception-property/route.ts",
    "src/app/api/import/reception-property/preview/route.ts",
  ])("%s は1ファイル経路なので通常の上限", (rel) => {
    const src = readFileSync(join(process.cwd(), rel), "utf-8");
    expect(src).toContain("assertImportJsonBodySize(request);");
    expect(src).not.toContain("MAX_IMPORT_JSON_BODY_BYTES_PAIRED");
  });
});

describe("JSON body を読む取込 route は全部ガードを通す", () => {
  const ROUTES = [
    "src/app/api/import/csv/route.ts",
    "src/app/api/import/csv/preview/route.ts",
    "src/app/api/import/owner-csv/route.ts",
    "src/app/api/import/reception-owner/route.ts",
    "src/app/api/import/reception-owner/preview/route.ts",
    "src/app/api/import/reception-property/route.ts",
    "src/app/api/import/reception-property/preview/route.ts",
    "src/app/api/import/registry-pdf/parse/route.ts",
    "src/app/api/import/registry-pdf/route.ts",
  ];

  it.each(ROUTES)("%s がガードを body 読み取り**前**に呼ぶ", (rel) => {
    const src = readFileSync(join(process.cwd(), rel), "utf-8");
    const guardIdx = src.indexOf("assertImportJsonBodySize(request");
    expect(guardIdx).toBeGreaterThan(0);
    // 実際の body 読み取り（await request.json() / parseJsonBody）より前にあること。
    const bodyIdx = src.search(/await\s+(request\.json\(\)|parseJsonBody\()/);
    expect(bodyIdx).toBeGreaterThan(0);
    expect(guardIdx).toBeLessThan(bodyIdx);
  });
});

describe("ローカル保存先の fail-closed（本番で未設定なら起動させない）", () => {
  it("public/uploads へのフォールバックは production では throw する", () => {
    const src = readFileSync(
      join(process.cwd(), "src/lib/storage/local-paths.ts"),
      "utf-8",
    );
    expect(src).toContain('process.env.NODE_ENV === "production"');
    expect(src).toMatch(/LOCAL_UPLOAD_ROOT が未設定/);
    // フォールバック(public/uploads)は throw より後＝開発時のみ到達する。
    expect(src.indexOf('NODE_ENV === "production"')).toBeLessThan(
      src.indexOf('path.join(process.cwd(), "public", "uploads")'),
    );
  });
});

describe("起動時の保存先検証（Codex #349 P1: 遅延throwでは起動を止められない）", () => {
  it("instrumentation.ts が起動時フックで検証を呼ぶ", () => {
    const src = readFileSync(
      join(process.cwd(), "src/instrumentation.ts"),
      "utf-8",
    );
    expect(src).toContain("export async function register");
    expect(src).toContain("assertUploadRootSafeAtStartup");
    // Edge ランタイムでは node 依存の検証を走らせない。
    expect(src).toContain('NEXT_RUNTIME !== "nodejs"');
  });

  it("検証は public 配下の明示指定も拒否する（静的配信で認可を素通りするため）", () => {
    const src = readFileSync(
      join(process.cwd(), "src/lib/storage/local-paths.ts"),
      "utf-8",
    );
    expect(src).toContain("export function assertUploadRootSafeAtStartup");
    expect(src).toMatch(/public 配下.*を指しています/);
    // ⚠public/uploads の残存チェックは backend に依存しない(Codex R2 P1:
    // server/s3 へ切り替えても静的配信は残るため)。
    expect(src).toContain("件のファイルが残っています");
    const legacyIdx = src.indexOf("listPublicUploadFiles()");
    const backendIdx = src.indexOf('backend !== "local"');
    expect(legacyIdx).toBeGreaterThan(0);
    expect(legacyIdx).toBeLessThan(backendIdx);
  });
});

describe("public/uploads の検査失敗は fail-closed(Codex #349 R5 P1)", () => {
  const src = readFileSync(
    join(process.cwd(), "src/lib/storage/local-paths.ts"),
    "utf-8",
  );

  it("ENOENT(未作成)だけ無視し、それ以外の読み取り失敗は起動を止める", () => {
    // 実行のみ許可のディレクトリ等で「読めない=空」と誤認すると、残存ファイルが
    // 無認証で配られたまま起動してしまう。
    expect(src).toContain('code === "ENOENT"');
    expect(src).toMatch(/を検査できません/);
    expect(src).toMatch(/起動を中止します/);
    // catch 節で無条件 return していないこと(throw があること)。
    const walkBlock = src.slice(src.indexOf("function listPublicUploadFiles"));
    expect(walkBlock).toContain("throw new Error(");
  });
});

describe("保存先の symlink 回避（Codex #349 R3/R4 P1・実測で挙動確認済み）", () => {
  const src = readFileSync(
    join(process.cwd(), "src/lib/storage/local-paths.ts"),
    "utf-8",
  );

  it("実体パス(realpath)で比較する（見た目が外部の symlink を通さない）", () => {
    expect(src).toContain("fs.realpathSync");
    expect(src).toContain("realPathOrSelf(root)");
    expect(src).toContain("realPathOrSelf(path.resolve(process.cwd(), \"public\"))");
  });

  it("未作成パスでも**実在する最深の祖先**まで解決する", () => {
    // /safe/link/new-dir (link が public/uploads を指す) を通さないための実装。
    expect(src).toMatch(/実在する最深の祖先/);
    // 祖先を辿るループと、残りセグメントの継ぎ足しがあること。
    expect(src).toContain("path.dirname(current)");
    expect(src).toContain("tail.push(path.basename(current))");
    expect(src).toContain("path.join(real, ...tail.reverse())");
  });
});

describe(".env.example の記載が実装値と一致する（Codex #349 R7 P2）", () => {
  it("上限の数値が実装から乖離していない（プロキシ設定の根拠になるため）", () => {
    const env = readFileSync(join(process.cwd(), ".env.example"), "utf-8");
    const singleMb = MAX_IMPORT_JSON_BODY_BYTES / (1024 * 1024);
    const pairedMb = MAX_IMPORT_JSON_BODY_BYTES_PAIRED / (1024 * 1024);
    expect(env).toContain(`取込リクエスト全体の上限=${singleMb}MB`);
    expect(env).toContain(`2ファイル分で${pairedMb}MB`);
  });
});
