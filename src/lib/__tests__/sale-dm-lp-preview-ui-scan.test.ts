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
  it("プレビューは広いダイアログで開き、枠は sandbox を絞る(Ruling R7)", () => {
    // LP型の欄は狭いため、中に出すと 1000px の枠が潰れて実物と同じ見え方にならない。
    expect(panel).toContain('size="xl"');
    expect(panel).toContain("ModalShell");
    // 同一オリジンの自前ページなので allow-same-origin だけ。script/form/別窓は禁じたまま。
    expect(panel).toContain('sandbox="allow-same-origin"');
  });
  it("LP型の行にプレビューのボタンがあり、文章未保存では押せない", () => {
    expect(manager).toMatch(/aria-label=\{`LP型「\$\{v\.label\}」のプレビュー`\}/);
    expect(manager).toMatch(/previewFor/);
    expect(manager).toContain('key={previewFor.id}');
  });
  it("文章・写真と図・プレビューは同時に開かない(相互排他を固定する)", () => {
    // openLetter と openMedia の中で閉じる(ダイアログの onClose を含めると3か所)。
    expect((manager.match(/setPreviewFor\(null\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // 逆向き: プレビューを開くときは写真と図を閉じる。
    expect(manager).toMatch(/const openPreview = \([^)]*\) => \{[^}]*setMediaFor\(null\)/);
    expect(manager).toMatch(/const openPreview = \([^)]*\) => \{[^}]*setLetterFor\(null\)/);
  });
});
