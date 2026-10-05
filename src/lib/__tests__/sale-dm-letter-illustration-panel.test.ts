import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

vi.mock("@/lib/api-client", () => ({
  fetchSaleDmLpAssets: vi.fn(async () => ({ assets: [] })),
  saveSaleDmScenarioLetterIllustration: vi.fn(),
  uploadSaleDmLpAsset: vi.fn(),
  LP_ASSET_URL: (p: string) => `/lp-assets/${p}`,
}));
import LetterIllustrationPanel from "@/components/sale-dm/letter-illustration-panel";

const PID = "0123456789abcdef0123456789abcdef";
const code = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

describe("手紙のイラストの枠(台帳の画面)", () => {
  it("登録済みなら画像と「外す」、説明文が出る", () => {
    const html = renderToStaticMarkup(createElement(LetterIllustrationPanel, { scenarioId: "s1", illustration: { src: `/lp-assets/${PID}`, width: 1200, height: 400 }, onChanged: () => {} }));
    expect(html).toContain("手紙のイラスト");
    expect(html).toContain(`src="/lp-assets/${PID}"`);
    expect(html).toContain("イラストを選ぶ");
    expect(html).toContain("外す");
    expect(html).toContain("【イラスト】の行に入ります");
    expect(html).toContain("横長(約3:1)");
  });
  it("未登録なら画像も「外す」も出ない", () => {
    const html = renderToStaticMarkup(createElement(LetterIllustrationPanel, { scenarioId: "s1", illustration: null, onChanged: () => {} }));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("外す");
    expect(html).toContain("まだ登録されていません");
  });
  it("走査: 台帳の画面に枠が置かれ、保存は専用 API を呼ぶ", () => {
    expect(code("src/app/(dashboard)/admin/dm-scenarios/[id]/page.tsx")).toMatch(/<LetterIllustrationPanel[\s\S]*?scenarioId=\{scenario\.id\}[\s\S]*?illustration=\{scenario\.letterIllustration\}/);
    const api = code("src/lib/api-client.ts");
    expect(api).toMatch(/export async function saveSaleDmScenarioLetterIllustration\(/);
    expect(api).toContain("/letter-illustration`");
  });
});

describe("最終レビュー: 保存の失敗が選択の窓の裏に隠れない", () => {
  it("走査: 選んだら窓を閉じてから保存する(エラーは枠に見える)", () => {
    const src = code("src/components/sale-dm/letter-illustration-panel.tsx");
    const save = src.slice(src.indexOf("const save = async"), src.indexOf("return (", src.indexOf("const save = async")));
    const close = save.indexOf("setOpen(false)");
    const call = save.indexOf("saveSaleDmScenarioLetterIllustration(");
    expect(close).toBeGreaterThan(-1);
    expect(close).toBeLessThan(call);
  });
});

describe("@codex R1: 写真の一覧を読めなかったら選択の窓を開かない", () => {
  it("走査: loadAssets が成否を返し、成功したときだけ setOpen(true)", () => {
    const src = code("src/components/sale-dm/letter-illustration-panel.tsx");
    const open = src.slice(src.indexOf("const openLibrary = async"), src.indexOf("const save = async"));
    expect(open).toMatch(/if \(!\(await loadAssets\(\)\)\) return;/);
    expect(open.indexOf("if (!(await loadAssets())) return;")).toBeLessThan(open.indexOf("setOpen(true)"));
    const load = src.slice(src.indexOf("const loadAssets = async"), src.indexOf("const openLibrary = async"));
    expect(load).toMatch(/return true;/);
    expect(load).toMatch(/return false;/);
  });
});
