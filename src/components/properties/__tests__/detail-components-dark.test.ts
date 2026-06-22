import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const actionBarSrc = readFileSync(join(dir, "..", "action-bar.tsx"), "utf8");
const attachmentTabSrc = readFileSync(join(dir, "..", "attachment-tab.tsx"), "utf8");

// ===== action-bar.tsx =====
describe("action-bar.tsx dark: 配色 (phase2b 2b-3)", () => {
  // action-bar は全ボタンが純 accent（bg-green-600/bg-indigo-600/bg-red-600/bg-amber-600/bg-gray-600）
  // neutral light クラスが存在しないため dark: 変種は不要。ただしライト不変を担保する。
  it("ライトモード text-white はボタンに残っている", () => {
    expect(actionBarSrc).toContain("text-white");
  });
  it("ライトモードの純 accent ボタン色（bg-green-600）は残っている", () => {
    expect(actionBarSrc).toContain("bg-green-600");
  });
  it("ライトモードの純 accent ボタン色（bg-indigo-600）は残っている", () => {
    expect(actionBarSrc).toContain("bg-indigo-600");
  });
  it("ライトモードの純 accent ボタン色（bg-red-600）は残っている", () => {
    expect(actionBarSrc).toContain("bg-red-600");
  });
  it("ライトモードの純 accent ボタン色（bg-amber-600）は残っている", () => {
    expect(actionBarSrc).toContain("bg-amber-600");
  });
});

// ===== attachment-tab.tsx =====
describe("attachment-tab.tsx dark: 配色 (phase2b 2b-3)", () => {
  // --- 面（背景） ---
  it("カード/パネル面に dark:bg-gray-900 がある", () => {
    expect(attachmentTabSrc).toContain("dark:bg-gray-900");
  });
  it("モーダル本文面に dark:bg-gray-800 がある", () => {
    expect(attachmentTabSrc).toContain("dark:bg-gray-800");
  });

  // --- drop ゾーン枠線 ---
  it("drop ゾーンの点線枠に dark:border-gray-700 がある", () => {
    expect(attachmentTabSrc).toContain("dark:border-gray-700");
  });

  // --- 行/ボタン hover ---
  it("drop ゾーン hover に dark:hover:bg-gray-800 がある", () => {
    expect(attachmentTabSrc).toContain("dark:hover:bg-gray-800");
  });

  // --- 文字（本文2階調） ---
  it("本文・パネルタイトルに dark:text-gray-100 がある", () => {
    expect(attachmentTabSrc).toContain("dark:text-gray-100");
  });
  it("見出し・ラベルに dark:text-gray-200 がある (text-gray-700 対応)", () => {
    expect(attachmentTabSrc).toContain("dark:text-gray-200");
  });
  it("本文説明テキストに dark:text-gray-300 がある (text-gray-600 対応)", () => {
    expect(attachmentTabSrc).toContain("dark:text-gray-300");
  });
  it("薄文字・メタ情報に dark:text-gray-400 がある (text-gray-500 対応)", () => {
    expect(attachmentTabSrc).toContain("dark:text-gray-400");
  });
  it("アイコン/プレースホルダーに dark:text-gray-500 がある (text-gray-400 対応)", () => {
    expect(attachmentTabSrc).toContain("dark:text-gray-500");
  });

  // --- 枠線 ---
  it("行カード枠線に dark:border-gray-800 がある (border-gray-200 対応)", () => {
    expect(attachmentTabSrc).toContain("dark:border-gray-800");
  });

  // --- hover 可読化（icon ボタン：accent hover 上の暗背景対応） ---
  it("preview/download アイコンボタンの hover:bg-indigo-50 に dark:hover:bg-gray-800 が同行にある", () => {
    // hover:bg-indigo-50 ... dark:hover:bg-gray-800 が同一 className 文字列内に共存すること
    const token = "hover:bg-indigo-50 hover:text-indigo-500 dark:hover:bg-gray-800";
    expect(attachmentTabSrc).toContain(token);
  });

  // --- close ボタン neutral hover ---
  it("モーダル閉じるボタンに dark:hover:bg-gray-700 がある", () => {
    expect(attachmentTabSrc).toContain("dark:hover:bg-gray-700");
  });

  // --- ライト側クラスが依然存在する（不変担保） ---
  it("ライトモード bg-white は残っている", () => {
    expect(attachmentTabSrc).toContain("bg-white");
  });
  it("ライトモード text-gray-600 は残っている", () => {
    expect(attachmentTabSrc).toContain("text-gray-600");
  });
  it("ライトモード border-gray-300 は残っている（drop ゾーン枠）", () => {
    expect(attachmentTabSrc).toContain("border-gray-300");
  });
  it("ライトモード border-gray-200 は残っている（行カード枠）", () => {
    expect(attachmentTabSrc).toContain("border-gray-200");
  });
  it("ライトモード text-gray-500 は残っている", () => {
    expect(attachmentTabSrc).toContain("text-gray-500");
  });
  it("ライトモード text-gray-700 は残っている", () => {
    expect(attachmentTabSrc).toContain("text-gray-700");
  });
  it("ライトモード bg-gray-50 は残っている（drop ゾーン）", () => {
    expect(attachmentTabSrc).toContain("bg-gray-50");
  });
  it("ライトモード bg-gray-100 は残っている（モーダル本文）", () => {
    expect(attachmentTabSrc).toContain("bg-gray-100");
  });

  // --- 謄本 iframe のサイズクラスは維持されている（#218 非接触） ---
  it("preview モーダルの max-w-[90vw] は維持されている", () => {
    expect(attachmentTabSrc).toContain("max-w-[90vw]");
  });

  // --- P2-1: プレビュー可能ファイル名リンク暗背景色 ---
  it("プレビュー可能ファイル名ボタンに dark:text-indigo-400 がある", () => {
    expect(attachmentTabSrc).toContain("dark:text-indigo-400");
  });

  // --- P2-2: ドロップゾーン drag-active 暗背景 ---
  it("general ドロップゾーン active 分岐に dark:bg-blue-500/15 がある", () => {
    expect(attachmentTabSrc).toContain("dark:bg-blue-500/15");
  });
  it("registry ドロップゾーン active 分岐に dark:bg-amber-500/15 がある", () => {
    expect(attachmentTabSrc).toContain("dark:bg-amber-500/15");
  });

  // --- 既存 lint ワーニング（pre-existing: line 383 付近 static-components）は放置 ---
  // このテストでは hook lint の有無を assert しない（変更対象外）
});
