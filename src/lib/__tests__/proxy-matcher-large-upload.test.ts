/**
 * 大きいPDFを受け取る口は proxy を通さない(2026-10-10・@codex PR#498 P1)。
 *
 * proxy があると Next.js は本文を proxyClientMaxBodySize(既定 10MB)まで先読みし、超えた分を
 * 黙って切る。上限を全体に上げると、クッキーの有無しか見ない proxy の手前で認証前の送信に
 * メモリを使わせることになるので、対象の口だけを matcher から外した。
 * ⚠外した口は「認証 → 大きさの事前チェック → 本文を読む」の順であることも、ここで走査して固定する。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import nextConfig from "../../../next.config";
import { config, LARGE_UPLOAD_API_PATTERN } from "@/proxy";

const matcher = config.matcher[0];
// Next の matcher はパス全体に対する正規表現として評価される。
const re = new RegExp(`^${matcher}$`);

describe("proxy の matcher", () => {
  it.each([
    "/api/properties/0b6f6c1e-0000-4000-8000-000000000000/attachments",
    "/api/import/paste",
    "/api/import/paste/commit",
  ])("大きいPDFを受け取る口は proxy を通さない: %s", (p) => {
    expect(re.test(p)).toBe(false);
  });

  it.each([
    "/",
    "/properties",
    "/api/properties",
    "/api/properties/abc",
    "/api/properties/abc/photos",
    "/api/properties/abc/attachments/att-1",
    "/api/import/paste/excel",
    "/api/import/paste-other",
    "/api/import/jobs",
  ])("それ以外の画面・API は今までどおり proxy を通る: %s", (p) => {
    expect(re.test(p)).toBe(true);
  });

  it("matcher の文字列と、テスト用に公開した対象の一覧が一致している", () => {
    expect(matcher).toContain(LARGE_UPLOAD_API_PATTERN);
  });

  it("★本文の先読みの上限は全体では上げない(proxyClientMaxBodySize は既定のまま)", () => {
    const exp = nextConfig.experimental as { proxyClientMaxBodySize?: unknown } | undefined;
    expect(exp?.proxyClientMaxBodySize).toBeUndefined();
  });
});

describe("proxy を通さない口は、本文を読む前に認証と大きさの確認をする", () => {
  const root = process.cwd();
  it.each([
    "src/app/api/properties/[id]/attachments/route.ts",
    "src/app/api/import/paste/route.ts",
    "src/app/api/import/paste/commit/route.ts",
  ])("%s", (file) => {
    const src = readFileSync(path.join(root, file), "utf8");
    const post = src.slice(src.indexOf("export async function POST"));
    const auth = post.indexOf("getApiSession()");
    const firstRead = Math.min(
      ...["request.formData()", "request.json()"].map((s) => {
        const i = post.indexOf(s);
        return i === -1 ? Infinity : i;
      }),
    );
    expect(auth).toBeGreaterThan(-1);
    expect(firstRead).toBeLessThan(Infinity);
    expect(auth).toBeLessThan(firstRead);
    // 本文を読む呼び出しの直前に、Content-Length の確認がある。
    for (const s of ["request.formData()", "request.json()"]) {
      let i = post.indexOf(s);
      while (i !== -1) {
        const before = post.slice(0, i);
        const lastGuard = Math.max(
          before.lastIndexOf("assertImportMultipartBodySize("),
          before.lastIndexOf("assertImportJsonBodySize("),
        );
        expect(lastGuard, `${file}: ${s} の前に大きさの確認が無い`).toBeGreaterThan(-1);
        i = post.indexOf(s, i + 1);
      }
    }
  });
});
