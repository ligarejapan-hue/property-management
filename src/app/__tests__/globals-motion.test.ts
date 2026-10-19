/**
 * UIの統一と押した手応え 第1回: 全ボタンの規則・動きのトークン(設計書 §1・§2)。
 * CSS は実行できないので、規則の存在と「外し方」を文字列で固定する。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");
const css = read("src/app/globals.css");

describe("動きのトークン", () => {
  it("曲線と出入りの動きを @theme に持つ", () => {
    expect(css).toContain("--ease-out-soft: cubic-bezier(.2, .8, .2, 1);");
    for (const name of ["pm-dialog-in", "pm-backdrop-in", "pm-pop", "pm-shimmer", "pm-toast-in"]) {
      expect(css).toContain(`--animate-${name}:`);
      expect(css).toContain(`@keyframes ${name}`);
    }
  });
  it("出入りは 220ms", () => {
    expect(css).toMatch(/--animate-pm-dialog-in: pm-dialog-in 220ms var\(--ease-out-soft\)/);
    expect(css).toMatch(/--animate-pm-toast-in: pm-toast-in 220ms var\(--ease-out-soft\)/);
  });
});

describe("全ボタンの手応え(@layer base)", () => {
  const base = css.slice(css.indexOf("@layer base {"));
  it("@layer base の中にある(= utilities の指定が必ず勝つ)", () => {
    expect(css).toContain("@layer base {");
    expect(base).toContain(":where(button)");
  });
  it("対象外: aria-pressed・data-motion=off とその中", () => {
    expect(base).toContain(
      ':not(:where([aria-pressed], [data-motion="off"], [data-motion="off"] *))',
    );
  });
  it("押すと scale .97(transform ではなく scale プロパティ)", () => {
    expect(base).toContain("scale: 0.97;");
    expect(base).not.toMatch(/transform:\s*scale\(0?\.97\)/);
  });
  it("押せない状態では沈まない", () => {
    expect(base).toContain(':disabled, [aria-disabled="true"]');
  });
  it("押下は 120ms", () => {
    expect(base).toContain("transition-duration: 180ms, 180ms, 180ms, 180ms, 120ms;");
  });
  it("沈みと影の動きは reduced-motion で出さない(no-preference の中だけ)", () => {
    const np = base.slice(base.indexOf("@media (prefers-reduced-motion: no-preference)"));
    expect(base.indexOf("@media (prefers-reduced-motion: no-preference)")).toBeGreaterThan(-1);
    expect(np).toContain("scale: 0.97;");
    expect(np).toContain("box-shadow");
    // no-preference の外(手前)には沈みを書かない
    expect(base.slice(0, base.indexOf("@media (prefers-reduced-motion: no-preference)"))).not.toContain("scale");
  });
  it("キーボードで選んだ時に藍の枠", () => {
    expect(base).toMatch(/:focus-visible\s*\{[^}]*outline: 2px solid var\(--color-indigo-500\)/);
  });
});

describe("対象外の印", () => {
  it("地図の外枠(丸ボタン群)", () => {
    expect(read("src/components/field-survey/field-survey-map.tsx")).toContain(
      '<div data-motion="off" className="relative h-full w-full">',
    );
  });
  it("謄本の実況パネル(中止ボタン・写真の縮小表示)", () => {
    expect(read("src/components/properties/registry-live-panel.tsx")).toMatch(
      /data-testid="registry-live-panel"\s+data-motion="off"/,
    );
  });
});
