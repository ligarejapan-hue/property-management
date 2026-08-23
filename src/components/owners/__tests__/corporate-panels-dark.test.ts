import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const lookupSrc = readFileSync(join(dir, "..", "corporate-lookup-panel.tsx"), "utf8");
const cleanupSrc = readFileSync(join(dir, "..", "corporate-cleanup-panel.tsx"), "utf8");
const auditSrc = readFileSync(
  join(dir, "..", "..", "..", "app", "(dashboard)", "admin", "owners", "quality-audit", "page.tsx"),
  "utf8",
);
const hygieneSrc = readFileSync(
  join(dir, "..", "..", "..", "app", "(dashboard)", "admin", "owners", "text-hygiene", "page.tsx"),
  "utf8",
);

// -----------------------------------------------------------------------
// CorporateLookupPanel dark: 配色 (P2-1)
// -----------------------------------------------------------------------
describe("CorporateLookupPanel dark: 配色 (P2-1)", () => {
  it("補助文字に dark:text-gray-400 がある", () => {
    expect(lookupSrc).toContain("dark:text-gray-400");
  });
  it("本文に dark:text-gray-300 または dark:text-gray-200 がある", () => {
    const has = lookupSrc.includes("dark:text-gray-300") || lookupSrc.includes("dark:text-gray-200");
    expect(has).toBe(true);
  });
  it("プレビューパネル面に dark:bg-gray-900 または dark:bg-blue-950 がある", () => {
    const has = lookupSrc.includes("dark:bg-gray-900") || lookupSrc.includes("dark:bg-blue-950");
    expect(has).toBe(true);
  });
  it("枠線に dark:border-gray-800 がある", () => {
    expect(lookupSrc).toContain("dark:border-gray-800");
  });
  it("PreviewField dt に dark:text-gray-400 がある", () => {
    expect(lookupSrc).toContain("dark:text-gray-400");
  });
  it("PreviewField dd に dark:text-gray-100 がある", () => {
    expect(lookupSrc).toContain("dark:text-gray-100");
  });
  it("ライトモード text-gray-500 は残っている", () => {
    expect(lookupSrc).toContain("text-gray-500");
  });
  it("純 accent ボタン（bg-indigo-600）は dark: 据え置き", () => {
    expect(lookupSrc).toContain("bg-indigo-600");
  });

  // --- T4 追加: 取りこぼし darken（generic error/success/neutral）---
  it("検索ボタン(blue outline)に dark の bg/border/text/hover", () => {
    expect(lookupSrc).toContain(
      "text-blue-700 hover:bg-blue-100 dark:border-blue-400/20 dark:bg-blue-500/10 dark:text-blue-300 dark:hover:bg-blue-500/20",
    );
  });
  it("検索エラーパネル(red)に dark", () => {
    expect(lookupSrc).toContain(
      "bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-400/20 dark:bg-red-500/10 dark:text-red-300",
    );
  });
  it("反映成功(green)に dark", () => {
    expect(lookupSrc).toContain(
      "bg-green-50 px-2.5 py-1.5 text-[11px] text-green-700 dark:border-green-400/20 dark:bg-green-500/10 dark:text-green-300",
    );
  });
  it("入力ヒント(amber)に dark:text-amber-400", () => {
    expect(lookupSrc).toContain("text-amber-600 dark:text-amber-400");
  });
  it("反映チェックボックスの枠に dark:border-gray-700", () => {
    expect(lookupSrc).toContain(
      "border-gray-300 text-indigo-600 focus:ring-indigo-500 disabled:opacity-50 dark:border-gray-700",
    );
  });

  // --- CORPORATE 色ロック（conflict 警告 / 廃止法人 バッジ）は非接触＝light維持 ---
  it("conflict 警告(amber)は light のまま据え置き（color-lock 非接触）", () => {
    expect(lookupSrc).toContain("border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800");
  });
  it("廃止法人バッジ(red)は light のまま据え置き（color-lock 非接触）", () => {
    expect(lookupSrc).toContain("border border-red-300 bg-red-100 px-2 py-0.5 text-[10px] font-bold text-red-700");
  });
});

// -----------------------------------------------------------------------
// CorporateCleanupPanel dark: 配色 (P2-1)
// -----------------------------------------------------------------------
describe("CorporateCleanupPanel dark: 配色 (P2-1)", () => {
  it("パネル面に dark:bg-gray-900 がある", () => {
    expect(cleanupSrc).toContain("dark:bg-gray-900");
  });
  it("枠線に dark:border-gray-800 がある", () => {
    expect(cleanupSrc).toContain("dark:border-gray-800");
  });
  it("変更差分テキストに dark:text-gray-300 がある", () => {
    expect(cleanupSrc).toContain("dark:text-gray-300");
  });
  it("「混入なし」メッセージに dark:text-slate-400 がある", () => {
    expect(cleanupSrc).toContain("dark:text-slate-400");
  });
  it("ライトモード text-slate-500 は残っている", () => {
    expect(cleanupSrc).toContain("text-slate-500");
  });
  it("ライトモード text-slate-600 は残っている", () => {
    expect(cleanupSrc).toContain("text-slate-600");
  });
  it("純 accent ボタンは藍(bg-indigo-600)・dark: 据え置き", () => {
    // UI一貫性 第1弾(4)で青(blue)→藍(indigo)へ統一した。
    expect(cleanupSrc).toContain("bg-indigo-600");
    expect(cleanupSrc).not.toContain("bg-blue-600");
  });
  // --- P2 追加: 清掃チェックボタンの dark 可読化 ---
  it("清掃チェックボタンに dark:bg-gray-800 がある（暗背景地）", () => {
    expect(cleanupSrc).toContain("dark:bg-gray-800");
  });
  it("清掃チェックボタンに dark:text-gray-200 がある（暗背景文字）", () => {
    expect(cleanupSrc).toContain("dark:text-gray-200");
  });
  it("清掃チェックボタンに dark:hover:bg-gray-700 がある（hover 可読化）", () => {
    expect(cleanupSrc).toContain("dark:hover:bg-gray-700");
  });
  it("完了メッセージ（混入除去）に dark:text-emerald-400 がある", () => {
    expect(cleanupSrc).toContain("dark:text-emerald-400");
  });
  it("ライトモード bg-slate-100 は残っている", () => {
    expect(cleanupSrc).toContain("bg-slate-100");
  });
  it("ライトモード text-slate-700 は残っている", () => {
    expect(cleanupSrc).toContain("text-slate-700");
  });

  // --- T4 追加: 取りこぼし darken ---
  it("エラー文(red)に dark:text-red-400", () => {
    expect(cleanupSrc).toContain("text-red-600 dark:text-red-400");
  });
  it("手動対応 amber に dark:text-amber-400", () => {
    expect(cleanupSrc).toContain("text-amber-700 dark:text-amber-400");
  });
});

// -----------------------------------------------------------------------
// 監査リンク dark:text-indigo-400 (P2-2)
// -----------------------------------------------------------------------
describe("quality-audit/page.tsx 監査リンク dark: (P2-2)", () => {
  it("所有者IDリンクに dark:text-indigo-400 がある", () => {
    expect(auditSrc).toContain("dark:text-indigo-400");
  });
  it("所有者IDリンクに dark:hover:text-indigo-300 がある", () => {
    expect(auditSrc).toContain("dark:hover:text-indigo-300");
  });
  it("ライトモード text-indigo-600 は残っている", () => {
    expect(auditSrc).toContain("text-indigo-600");
  });
  it("ライトモード hover:text-indigo-800 は残っている", () => {
    expect(auditSrc).toContain("hover:text-indigo-800");
  });
});

describe("text-hygiene/page.tsx 監査リンク dark: (P2-2)", () => {
  it("所有者IDリンクに dark:text-indigo-400 がある", () => {
    expect(hygieneSrc).toContain("dark:text-indigo-400");
  });
  it("所有者IDリンクに dark:hover:text-indigo-300 がある", () => {
    expect(hygieneSrc).toContain("dark:hover:text-indigo-300");
  });
  it("ライトモード text-indigo-600 は残っている", () => {
    expect(hygieneSrc).toContain("text-indigo-600");
  });
});
