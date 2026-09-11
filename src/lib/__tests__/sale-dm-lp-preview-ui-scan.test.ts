import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const read = (f: string) => readFileSync(path.resolve(process.cwd(), f), "utf8").replace(/\r\n/g, "\n");
describe("LPプレビュー画面", () => {
  const panel = read("src/components/sale-dm/lp-preview-panel.tsx");
  const manager = read("src/components/sale-dm/lp-variant-manager.tsx");
  it("iframe は LP_PREVIEW_URL 経由・PC/スマホの切替が aria-pressed 付きである", () => {
    expect(panel).toMatch(/<iframe[^>]*src=\{LP_PREVIEW_URL\(/);
    expect((panel.match(/aria-pressed/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(panel).toContain("390");
    expect(panel).toContain("1000");
    expect(panel).not.toContain("dangerouslySetInnerHTML");
  });
  it("LP型の行にプレビューのボタンがあり、文章未保存では押せない", () => {
    expect(manager).toMatch(/aria-label=\{`LP型「\$\{v\.label\}」のプレビュー`\}/);
    expect(manager).toMatch(/previewFor/);
    expect(manager).toContain('key={previewFor.id}');
  });
});
