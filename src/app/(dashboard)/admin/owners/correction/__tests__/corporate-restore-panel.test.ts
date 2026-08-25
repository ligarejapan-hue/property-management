/**
 * 法人番号紐づけタブ(CorporateRestorePanel)の配線・文言テスト。
 * ⚠タブ名は左メニューの項目名と一致させる(2026-08-25 の見出し統一)。
 * vitest は env=node(jsdom なし)のため、リポ慣行に従いソース文字列で検証する。
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, it, expect } from "vitest";

const src = readFileSync(resolve(__dirname, "../page.tsx"), "utf-8");

describe("法人番号紐づけタブの配線", () => {
  it("タブ定義に corporate_restore がある", () => {
    expect(src).toContain('{ key: "corporate_restore", label: "法人番号紐づけ" }');
  });

  it("SELF_FETCH_TABS に corporate_restore が含まれる(上位fetchの対象外)", () => {
    const selfFetch = src.match(/SELF_FETCH_TABS: FilterType\[\] = \[[^\]]*\]/);
    expect(selfFetch).not.toBeNull();
    expect(selfFetch![0]).toContain('"corporate_restore"');
  });

  it("URL query からの復元(parseFilterTypeFromQuery)に corporate_restore がある", () => {
    const parse = src.match(
      /function parseFilterTypeFromQuery[\s\S]*?\n\}/,
    );
    expect(parse).not.toBeNull();
    expect(parse![0]).toContain('case "corporate_restore":');
  });

  it("corporate_restore タブで CorporateRestorePanel を描画する", () => {
    expect(src).toContain(
      '{filterType === "corporate_restore" && <CorporateRestorePanel />}',
    );
  });
});

describe("法人番号復元タブの文言(平易な日本語・開発用語を出さない)", () => {
  const panel = src.slice(src.indexOf("function CorporateRestorePanel"));

  it("パネルが存在する", () => {
    expect(panel.length).toBeGreaterThan(100);
  });

  it("説明文に業務語彙で目的が書かれている", () => {
    expect(panel).toContain("会社法人等番号が途中で割れてしまった法人所有者");
    expect(panel).toContain("正しい会社名(と住所)を復元");
  });

  it("空状態の案内がある", () => {
    expect(panel).toContain("割れた会社法人等番号は見つかりませんでした");
  });

  it("住所モードの選択肢が平易に書かれている", () => {
    expect(panel).toContain("住所と郵便番号も国税庁の最新本店所在地に更新する(推奨)");
  });

  it("ユーザー向け文言に dry-run 等の開発用語を含まない", () => {
    // JSX テキスト断片を対象に、開発用語がないことを確認する(コメントは除外)
    const withoutComments = panel
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(withoutComments).not.toMatch(/dry-?run|soft-?delete|lookup/i);
  });

  it("PII 面が data-pii-protected で保護されている", () => {
    expect(panel).toContain('data-pii-protected');
    expect(panel).toContain('data-pii-surface="owner"');
  });

  it("ダークモードのクラスが主要面に入っている", () => {
    expect(panel).toContain("bg-white dark:bg-gray-900");
    expect(panel).toContain("text-gray-900 dark:text-gray-100");
  });
});
