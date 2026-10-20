import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "trip-controls.tsx"), "utf8");

describe("trip-controls.tsx dark: 配色 (field-survey phase)", () => {
  // --- 面（背景） ---
  it("ModalShell 内パネルに dark:bg-gray-900 がある (bg-white 対応)", () => {
    expect(src).toContain("dark:bg-gray-900");
  });

  // --- 文字 ---
  it("セクションラベルに dark:text-gray-300 がある (text-gray-600 対応)", () => {
    expect(src).toContain("dark:text-gray-300");
  });
  it("薄文字・補足テキストに dark:text-gray-400 がある (text-gray-500 対応)", () => {
    expect(src).toContain("dark:text-gray-400");
  });
  it("dl 本文・本文テキストに dark:text-gray-200 がある (text-gray-700 対応)", () => {
    expect(src).toContain("dark:text-gray-200");
  });
  it("モーダルタイトルに dark:text-gray-100 がある (text-gray-800 対応)", () => {
    expect(src).toContain("dark:text-gray-100");
  });
  it("モーダル本文 text-gray-700 に dark:text-gray-200 がある", () => {
    expect(src).toContain("dark:text-gray-200");
  });

  // --- 枠 ---
  it("Panel / セクション区切り border-gray-200 に dark:border-gray-800 がある", () => {
    expect(src).toContain("dark:border-gray-800");
  });
  it("キャンセルボタン枠 border-gray-300 に dark:border-gray-700 がある", () => {
    expect(src).toContain("dark:border-gray-700");
  });

  // --- hover ---
  // UIの統一 第4回: 確認の2ボタン(ModalActions)は共通 Button(暗い面の hover は部品側が持つ)
  it("確認のキャンセルは共通 Button の secondary（dark:hover:bg-gray-800 は部品側）", () => {
    expect(src).toContain('<Button variant="secondary" size="sm" onClick={onCancel}>');
  });

  // --- amber エラーバナー ---
  it("エラーバナーに dark:bg-amber-500/15 がある", () => {
    expect(src).toContain("dark:bg-amber-500/15");
  });
  it("エラーバナーに dark:text-amber-300 がある", () => {
    expect(src).toContain("dark:text-amber-300");
  });
  it("エラーバナーに dark:border-amber-500/40 がある", () => {
    expect(src).toContain("dark:border-amber-500/40");
  });

  // --- red accent 「破棄して終了」ボタン ---
  // UIの統一 第4回: 「破棄して終了」は共通 Button の danger(赤の配色は部品側が持つ)
  it("破棄して終了は共通 Button の danger", () => {
    expect(src).toMatch(/variant="danger"[\s\S]{0,80}data-testid="trip-discard-and-end"/);
  });

  // --- ライト不変担保 ---
  it("ライトモード bg-white は残っている", () => {
    expect(src).toContain("bg-white");
  });
  it("ライトモード text-gray-600 は残っている", () => {
    expect(src).toContain("text-gray-600");
  });
  it("ライトモード text-gray-500 は残っている", () => {
    expect(src).toContain("text-gray-500");
  });
  it("ライトモード text-gray-700 は残っている", () => {
    expect(src).toContain("text-gray-700");
  });
  it("ライトモード text-gray-800 は残っている", () => {
    expect(src).toContain("text-gray-800");
  });
  it("ライトモード border-gray-200 は残っている", () => {
    expect(src).toContain("border-gray-200");
  });
  it("ライトモード border-gray-300 は残っている", () => {
    expect(src).toContain("border-gray-300");
  });
  it("ライトモード bg-amber-50 は残っている", () => {
    expect(src).toContain("bg-amber-50");
  });
  // hover:bg-gray-50 はキャンセルボタンの色だった=共通 Button へ移った(上の secondary で担保)
  // 2026-07-29: 初回だけ出す位置記録の同意ブロック (開始確認 modal 内)
  it("初回同意ブロックの面に dark:bg-gray-800/40 がある (bg-gray-50 対応)", () => {
    expect(src).toContain("dark:bg-gray-800/40");
  });
  it("初回同意ブロックの枠 border-gray-300 に dark:border-gray-700 がある", () => {
    expect(src).toContain("dark:border-gray-700");
  });

  // UIの統一 第4回: 同意側は共通 Button の primary(藍の塗りは部品側)
  it("確認の同意ボタンは共通 Button の primary (ModalActions agree)", () => {
    expect(src).toContain('<Button variant="primary" size="sm" onClick={onAgree}>');
  });

  // --- 事前敵対レビュー対応: ● 巡回中 status を StatusLine と整合 (dark:text-red-400) ---
  it("ActiveSessionView の ● 巡回中 status に text-red-600 dark:text-red-400 がある", () => {
    expect(src).toContain("text-red-600 dark:text-red-400");
  });
});
