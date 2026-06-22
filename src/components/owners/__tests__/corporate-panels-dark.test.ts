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
  it("純 accent ボタン（bg-blue-600）は dark: 据え置き", () => {
    expect(cleanupSrc).toContain("bg-blue-600");
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
