/**
 * 前提条件(capability)の置き換え(設計 §2.5)。
 *
 * 旧 `saleDmLetter` は「AI設定 + 追跡URL + LP + 差出人」が揃っているかを見ていた。
 * AI直結を廃止したので、必要なのは**印刷の前提だけ**＝`saleDmPrintReady` に置き換える。
 * ⚠置換漏れがあると、AI設定が無い環境で導線が出ない（外部AI方式が使えない）まま残る。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

// ⚠この検査ファイル自身は旧名を文字列として含むので除外する。
const SELF = "sale-dm-capability-rename.test.ts";
const FILES = walk(path.resolve(process.cwd(), "src")).filter((f) => !f.endsWith(SELF));

describe("capability の置換", () => {
  it("走査できている", () => {
    expect(FILES.length).toBeGreaterThan(100);
  });

  it("旧 saleDmLetter は 1 件も残っていない", () => {
    const left = FILES.filter((f) =>
      readFileSync(f, "utf-8").includes("saleDmLetter"),
    ).map((f) => path.relative(process.cwd(), f).split(path.sep).join("/"));
    expect(left).toEqual([]);
  });

  it("新 saleDmPrintReady が使われている", () => {
    const used = FILES.filter((f) =>
      readFileSync(f, "utf-8").includes("saleDmPrintReady"),
    );
    expect(used.length).toBeGreaterThanOrEqual(3);
  });

  it("印刷の前提だけを見る(AI設定 isSaleDmConfigured を条件にしない)", () => {
    const src = readFileSync(
      path.resolve(process.cwd(), "src/app/api/me/permissions/route.ts"),
      "utf-8",
    );
    const line = src.split("\n").find((l) => l.includes("saleDmPrintReady:"));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/isSaleDmConfigured/);
  });
});
