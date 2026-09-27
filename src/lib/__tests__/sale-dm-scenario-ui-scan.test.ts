import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

describe("DMの種類の画面(設計 §3.6)", () => {
  it("共用部品は発送用の呼び先を直接書かない(呼び先は api で受け取る)", () => {
    for (const f of ["src/components/sale-dm/lp-media-panel.tsx", "src/components/sale-dm/lp-preview-panel.tsx"]) {
      const src = read(f);
      expect(src, f).not.toMatch(/fetchSaleDmLpMedia|saveSaleDmLpMedia|fetchSaleDmLpImagePrompt|LP_PREVIEW_URL|campaignId/);
      // 発送の口の URL を部品に直書きしない(Task 9 review Minor 5)。
      expect(src, f).not.toContain("/campaigns/");
    }
  });
  it("LpMediaApi はプレビューの URL を持たない(プレビューは LpPreviewPanel へ別に渡す・Task 9 review Minor 3)", () => {
    const src = read("src/lib/api-client.ts");
    const m = src.match(/export type LpMediaApi = \{[\s\S]*?\n\};/);
    expect(m).not.toBeNull();
    expect(m![0]).not.toContain("previewUrl");
  });
  it("変更履歴の「DMの種類」は id を名前に直して出す(使わない・削除済みも含む一覧を使う・設計 §3.4)", () => {
    const src = read("src/components/properties/history-tab.tsx");
    expect(src).toMatch(/dmScenarioHistoryLabel\(/);
    expect(src).toMatch(/fetchSaleDmScenarioOptionsAll\(/);
  });
  it("追加の指示は前後の空白を落として送る(Task 9 review Minor 4)", () => {
    expect(read("src/components/sale-dm/scenario-text-editor.tsx")).toMatch(/extraInstruction: extra\.trim\(\)/);
  });
  it("サイドバーに「DMの種類」(管理者のみ)", () => {
    expect(read("src/components/layout/sidebar-model.tsx")).toMatch(/label:\s*"DMの種類",\s*href:\s*"\/admin\/dm-scenarios"[^}]*minRole:\s*"admin"/);
  });
  it("物件の欄は選択肢の口だけを使う(中身の口を叩かない)", () => {
    const src = read("src/components/properties/dm-scenario-field.tsx");
    expect(src).toMatch(/fetchSaleDmScenarioOptions/);
    expect(src).not.toMatch(/fetchSaleDmScenarios\b|fetchSaleDmScenario\(/);
  });
  it("写真と図の呼び先は useMemo で固定して渡す(描画ごとに作ると読み込みが止まらない)", () => {
    // LpMediaPanel は api が変わるたびに読み直す。呼び出し側で毎回作ると無限に読み直す。
    for (const f of ["src/components/sale-dm/lp-variant-manager.tsx", "src/app/(dashboard)/admin/dm-scenarios/[id]/page.tsx"]) {
      const src = read(f);
      expect(src, f).toMatch(/useMemo\(\s*\(\)\s*=>[^;]*(campaignLpMediaApi|scenarioLpMediaApi)\(/);
      expect(src, f).not.toMatch(/api=\{(campaignLpMediaApi|scenarioLpMediaApi)\(/);
    }
  });
  it("物件の欄の保存は既存の鍵なし保存(runNoLockPropertyPatch)を通す(自前の fetch を持たない)", () => {
    const src = read("src/components/properties/dm-scenario-field.tsx");
    expect(src).toMatch(/runNoLockPropertyPatch\(/);
    expect(src).not.toMatch(/fetch\(\s*`\/api\/properties/);
  });
  it("管理画面は相続・空き家(autoKey あり)に削除ボタンを出さない", () => {
    const src = read("src/app/(dashboard)/admin/dm-scenarios/page.tsx");
    expect(src).toMatch(/!s\.autoKey\s*&&/);
  });
});
