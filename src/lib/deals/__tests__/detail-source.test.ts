import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const PAGE = "src/app/(dashboard)/deals/[id]/page.tsx";
const PANELS = ["deal-basic-panel", "deal-property-panel", "deal-parties-panel"].map((n) => `src/components/deals/${n}.tsx`);

describe("取引の詳しい画面", () => {
  it("タブは 基本・物件・当事者 の順(共通のタブ部品)", () => {
    const src = read(PAGE);
    expect(src).toMatch(/\{ key: "basic", label: "基本" \},\s*\{ key: "property", label: "物件" \},\s*\{ key: "parties", label: "当事者" \}/);
    expect(src).toContain("<Tabs");
    expect(src).toContain("tabPanelProps(");
  });
  it("ほかの人が先に保存したら、読み込み直すよう知らせる", () => {
    for (const p of PANELS) expect(read(p), p).toContain("VERSION_CONFLICT");
  });
  it("物件から取り直す前に確かめる・物件を開くリンクは見られる人だけ", () => {
    const src = read(PANELS[1]);
    expect(src).toContain("物件から取り直す");
    expect(src).toContain("<ConfirmDialog");
    expect(src).toContain("canOpenProperty &&");
  });
  it("当事者は「自社を入れる」で会社情報を写せる・消す前に確かめる", () => {
    const src = read(PANELS[2]);
    expect(src).toContain("自社を入れる");
    expect(src).toContain("<ConfirmDialog");
  });
  it("素の button を使わない", () => {
    for (const p of [PAGE, ...PANELS]) expect(read(p), p).not.toMatch(/<button[\s>]/);
  });
});

describe("保存のあとの読み込みに失敗しても「保存中」のまま固まらない(最終レビュー I1)", () => {
  it("基本・物件のタブは finally で保存中を解く", () => {
    expect(read(PANELS[0])).toMatch(/finally \{\s*setSaving\(false\);/);
    expect(read(PANELS[1])).toMatch(/finally \{\s*setBusy\(false\);/);
  });
});
