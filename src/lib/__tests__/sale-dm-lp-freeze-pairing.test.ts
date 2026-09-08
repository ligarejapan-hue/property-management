/**
 * 「確定を作る／動かす／戻す」経路は DM型へ凍結印を立てている(markVariantsFrozen)。
 * 同じ経路は LP型の確定の証拠も消すので、**必ず対で** markLpVariantsFrozen も呼ぶ(設計 2026-09-08 §2.8)。
 * route 名を手で並べず、markVariantsFrozen を含む sale-dm の route を機械的に対象にする。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd(), "src/app/api/properties/sale-dm");
function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return routeFiles(p);
    return name === "route.ts" ? [p] : [];
  });
}
const FILES = routeFiles(ROOT).filter((f) => readFileSync(f, "utf-8").includes("markVariantsFrozen("));

describe("DM型へ凍結印を立てる経路は LP型へも立てる", () => {
  it("対象が見つかっている(0件なら検査が空振り)", () => {
    expect(FILES.length).toBeGreaterThanOrEqual(4);
  });
  for (const file of FILES) {
    const rel = path.relative(process.cwd(), file).replace(/\\/g, "/");
    it(rel, () => {
      const s = readFileSync(file, "utf-8");
      expect(s.includes("markLpVariantsFrozen("), `${rel} が LP型へ凍結印を立てていない`).toBe(true);
      // ロック順序: dm_variants → dm_lp_variants(両方を掴む経路では LP のロックが後)。
      const v = s.search(/FROM dm_variants[\s\S]{0,200}FOR UPDATE/);
      const l = s.search(/FROM dm_lp_variants[\s\S]{0,200}FOR UPDATE/);
      expect(l, `${rel} が dm_lp_variants をロックしていない`).toBeGreaterThan(-1);
      if (v > -1) expect(l).toBeGreaterThan(v);
      const p = s.search(/FROM properties[\s\S]{0,200}FOR UPDATE/);
      if (p > -1) expect(p, `${rel}: dm_lp_variants のロックは properties より先`).toBeGreaterThan(l);
    });
  }
});
