/**
 * §8-5 C1: 物件一覧モバイルカード表示 source-assertion テスト
 * vitest node 環境 (jsdom なし) — ファイル内容の文字列検査のみ
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "page.tsx"), "utf8");

describe("properties/page.tsx §8-5 C1: モバイルカード表示", () => {
  // --- PC/モバイル出し分け ---
  it("テーブル包み要素に hidden md:block がある（PC のみ表示）", () => {
    expect(src).toContain("hidden md:block");
  });

  it("カード節に md:hidden がある（モバイルのみ表示）", () => {
    // md:hidden はフィルタトグルにも存在するが、カード節でも使われていること
    // を確認する。"Card list" コメントと md:hidden の組み合わせで確認する。
    expect(src).toContain("Card list");
    expect(src).toContain("md:hidden");
  });

  // --- ダークモード ---
  it("カードの面に dark:bg-gray-900 がある", () => {
    expect(src).toContain("dark:bg-gray-900");
  });

  it("カードの文字に dark:text-gray-100 がある", () => {
    expect(src).toContain("dark:text-gray-100");
  });

  it("カードの文字に dark:text-gray-300 がある（サブテキスト）", () => {
    expect(src).toContain("dark:text-gray-300");
  });

  it("カードの枠に dark:border-gray-800 がある", () => {
    expect(src).toContain("dark:border-gray-800");
  });

  it("カードのホバーに dark:hover:bg-gray-800 がある", () => {
    expect(src).toContain("dark:hover:bg-gray-800");
  });

  // --- タップ遷移ガード（§8-4 と同一） ---
  it("カードのタップに metaKey ガードがある", () => {
    expect(src).toContain("e.metaKey");
  });

  it("カードのタップに closest ガードがある", () => {
    expect(src).toContain('closest("a, button, input, label, select, textarea")');
  });

  it("カードのタップに defaultPrevented ガードがある", () => {
    expect(src).toContain("e.defaultPrevented");
  });

  // --- 所有者展開 ---
  it("展開state に expandedOwners がある", () => {
    expect(src).toContain("expandedOwners");
  });

  it("「他N名 ▾」展開ボタンの「他」テキストがある", () => {
    // バックティックテンプレート内に `他${...}名` の形式が存在する
    expect(src).toContain("他");
    expect(src).toContain("名 ▾");
  });

  it("展開/折りたたみトグル（▴/▾）の両方が存在する", () => {
    expect(src).toContain("▾");
    expect(src).toContain("▴");
  });

  it("展開ボタンに stopPropagation がある（タップ誤遷移防止）", () => {
    // カードの onClick と展開ボタンの stopPropagation を確認
    expect(src).toContain("stopPropagation");
  });

  it("「他N名 ▾」展開ボタンのタップ領域が 44px 以上（min-h-[44px]）", () => {
    expect(src).toContain("min-h-[44px]");
  });

  // --- 選択チェックボックス ---
  it("カードにチェックボックスの selectedIds 参照がある", () => {
    expect(src).toContain("selectedIds");
  });

  // --- カード項目の整合性（テーブルと同じデータソース） ---
  it("カードに PROPERTY_TYPE_LABELS の参照がある（種別）", () => {
    expect(src).toContain("PROPERTY_TYPE_LABELS");
  });

  it("カードに REGISTRY_STATUS_INTENT の参照がある（登記状況バッジ）", () => {
    expect(src).toContain("REGISTRY_STATUS_INTENT");
  });

  it("カードに DM_STATUS_INTENT の参照がある（DM判断バッジ）", () => {
    expect(src).toContain("DM_STATUS_INTENT");
  });

  it("カードに CASE_STATUS_LABELS の参照がある（案件状況）", () => {
    expect(src).toContain("CASE_STATUS_LABELS");
  });

  // --- PII 保護 ---
  it("カードの所有者に data-pii-protected がある", () => {
    expect(src).toContain("data-pii-protected");
  });

  // --- キーボード/新規タブ導線（a11y §8-5 P2） ---
  it("カード節にスコープした Link(href=/properties/) がある（テーブル行でなくカード固有・キーボード・新規タブ対応）", () => {
    // "Card list" コメント以降をカード節として切り出し、その範囲内に Link と
    // href=詳細遷移が存在することを確認する。テーブル行の Link だけでは pass
    // しないため、カード側 Link 削除を回帰ガードとして検出できる。
    const cardSectionStart = src.indexOf("Card list");
    expect(cardSectionStart).toBeGreaterThan(-1); // マーカー自体の存在確認
    const cardSection = src.slice(cardSectionStart);
    expect(cardSection).toContain("<Link");
    expect(cardSection).toContain("href={`/properties/${property.id}`}");
  });

  // --- PC テーブル不変（回帰） ---
  it("回帰: PC テーブルの <table> 要素が依然存在する", () => {
    expect(src).toContain("<table");
  });

  it("回帰: PC テーブルの thead が依然存在する", () => {
    expect(src).toContain("<thead");
  });
});
