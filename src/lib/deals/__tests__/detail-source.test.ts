import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const PAGE = "src/app/(dashboard)/deals/[id]/page.tsx";
const PANELS = ["deal-basic-panel", "deal-property-panel", "deal-parties-panel"].map((n) => `src/components/deals/${n}.tsx`);

describe("取引の詳しい画面", () => {
  it("タブは 基本・物件・当事者・金額・費用・精算・OC の順(OC はオーナーチェンジのときだけ)", () => {
    const src = read(PAGE);
    expect(src).toMatch(/\{ key: "basic", label: "基本" \},\s*\{ key: "property", label: "物件" \},\s*\{ key: "parties", label: "当事者" \},\s*\{ key: "money", label: "金額・費用" \},\s*\{ key: "settlement", label: "精算" \},\s*\{ key: "oc", label: "OC" \}/);
    expect(src).toMatch(/deal\.hasOc \|\| t\.key !== "oc"/);
    expect(src).toContain("<Tabs");
    expect(src).toContain("tabPanelProps(");
  });
  it("タブを切り替えても入力が消えない: 全部描いて hidden で隠す・key はそのパネルのデータ(M3)", () => {
    const src = read(PAGE);
    expect(src).toContain('hidden={tab !== "basic"}');
    expect(src).toContain('hidden={tab !== "money"}');
    expect(src).not.toContain("key={deal.version}");
  });
  it("金額・費用タブ: 売買価格・手付金・税率・手数料と建物価格の上書き・費用", () => {
    const src = read("src/components/deals/deal-money-panel.tsx");
    for (const s of ["売買価格", "手付金", "消費税率", "仲介手数料", "低廉な空家等の特例", "建物価格", "建物消費税", "印紙税", "司法書士", "登記費用", "抹消費用", "測量費", "VERSION_CONFLICT"]) {
      expect(src, s).toContain(s);
    }
    expect(src).toContain("<OverrideField");
  });
  it("精算タブ: 条件の入力・結果の表(計算期間・計算式・売主→買主・買主→売主)・差引の1行・お支払額・上書き", () => {
    const src = read("src/components/deals/deal-settlement-panel.tsx");
    for (const s of ["固定資産税", "都市計画税", "起算日", "管理費", "修繕積立金", "前払い", "計算期間", "計算式", "売主→買主", "買主→売主", "netLine", "決済時のお支払額", "VERSION_CONFLICT", "<OverrideField"]) {
      expect(src, s).toContain(s);
    }
    expect(src).toMatch(/kindBase === "unit"/);
  });
  it("OC タブ: 部屋ごとの賃貸条件・敷金の相殺/別途", () => {
    const src = read("src/components/deals/deal-oc-panel.tsx");
    for (const s of ["部屋番号", "賃借人", "普通借家", "定期借家", "賃料", "共益費", "駐車場代", "預り敷金", "滞納", "管理会社", "残代金と相殺", "別途授受", "VERSION_CONFLICT"]) {
      expect(src, s).toContain(s);
    }
  });
  it("物件タブ: 評価額(筆ごと・持分・土地の割合)を入れて一緒に保存する", () => {
    const src = read(PANELS[1]);
    expect(src).toContain("<AssessmentsEditor");
    expect(src).toMatch(/assessments,/);
    const ed = read("src/components/deals/assessments-editor.tsx");
    for (const s of ["家屋評価額", "土地評価額", "持分", "土地の割合"]) expect(ed, s).toContain(s);
  });
  it("「物件から取り直す」は物件を見られる人にだけ出す(M4)", () => {
    expect(read(PANELS[1])).toMatch(/\{canOpenProperty && \(\s*<>[\s\S]*物件から取り直す/);
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
