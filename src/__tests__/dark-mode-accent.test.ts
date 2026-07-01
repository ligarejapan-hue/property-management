import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// src/__tests__ -> src
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

/**
 * 強調色(accent)の暗所コントラスト横断対応の回帰テスト。
 * 方針: 暗面(ページ地=dark:bg-gray-900 等)に乗る「素の accent 文字色」
 *       (リンク/エラー文/アイコン/アクティブタブ)に add-only で
 *       dark:text-{color}-{300|400} を付与。
 * 対象外: 淡い accent 地(bg-{color}-50/100/200)のバッジ/バナー/箱の中の文字
 *       (地色 dark:bg も要る)・色ロック分類タグ。
 */

// このPRでダーク文字色を追加したファイル群(add-only)
const TOUCHED = [
  "app/(auth)/login/page.tsx",
  "app/(dashboard)/admin/owners/[id]/page.tsx",
  "app/(dashboard)/admin/postal-code-audit/page.tsx",
  "app/(dashboard)/admin/templates/[id]/page.tsx",
  "app/(dashboard)/buildings/[id]/page.tsx",
  "app/(dashboard)/import/page.tsx",
  "app/(dashboard)/import/registry-pdf/page.tsx",
  "app/(dashboard)/properties/[id]/page.tsx",
  "app/(dashboard)/properties/page.tsx",
  "app/(dashboard)/properties/quality-check/page.tsx",
  "components/address/address-lookup-controls.tsx",
  "components/field-survey/field-survey-history-map.tsx",
  "components/field-survey/field-survey-map.tsx",
  "components/layout/sidebar.tsx",
  "components/owners/OwnerMislinkModal.tsx",
  "components/owners/owner-link-modal.tsx",
  "components/properties/action-bar.tsx",
];

const ACCENT = "indigo|blue|sky|violet|purple|emerald|green|amber|yellow|orange|red|rose|teal|cyan";

describe("accent 暗所コントラスト: 素accent文字に dark 変種(add-only)", () => {
  it("login: 入力エラー text-red-600 に dark:text-red-400", () => {
    expect(read("app/(auth)/login/page.tsx")).toContain("text-red-600 dark:text-red-400");
  });

  it("sidebar: ヘッダーアイコン text-indigo-600 に dark:text-indigo-400", () => {
    expect(read("components/layout/sidebar.tsx")).toContain("text-indigo-600 dark:text-indigo-400");
  });

  it("field-survey-map: 物件リンク text-indigo-600 hover:underline に dark:text-indigo-400", () => {
    expect(read("components/field-survey/field-survey-map.tsx")).toContain(
      "text-indigo-600 hover:underline dark:text-indigo-400",
    );
  });

  it("properties/[id]: アクティブタブ indigo / エラー red / 成功 green に dark 変種", () => {
    const s = read("app/(dashboard)/properties/[id]/page.tsx");
    expect(s).toContain("text-indigo-600 dark:text-indigo-400"); // active tab
    expect(s).toContain("text-red-600 dark:text-red-400"); // inline error
    expect(s).toContain("text-green-600 dark:text-green-400"); // save success
  });

  it("properties/page: モバイルカード種別 text-indigo-600 に dark:text-indigo-400", () => {
    expect(read("app/(dashboard)/properties/page.tsx")).toContain("text-indigo-600 dark:text-indigo-400");
  });

  it("buildings/[id]: エラー text-red-600 に dark:text-red-400", () => {
    expect(read("app/(dashboard)/buildings/[id]/page.tsx")).toContain("text-red-600 dark:text-red-400");
  });

  it("OwnerMislinkModal: 検索エラー text-red-600 に dark:text-red-400", () => {
    expect(read("components/owners/OwnerMislinkModal.tsx")).toContain("text-red-600 dark:text-red-400");
  });

  it("import: セクションアイコン green/blue に dark 変種", () => {
    const s = read("app/(dashboard)/import/page.tsx");
    expect(s).toContain("text-green-600 dark:text-green-400");
    expect(s).toContain("text-blue-600 dark:text-blue-400");
  });
});

describe("accent 暗所コントラスト: light-on-light 回帰ガード(JSXスコープ対応)", () => {
  // 淡い accent 地の「箱」の中の文字を暗色化すると、暗モードで淡地×淡文字=不可読。
  // 淡 accent 地は【親要素】に付き、dark:text は【子要素】の別行にあることが多い。
  // そこでインデントで JSX の祖先を遡り、その文字の「最寄りの背景設定要素」を特定して、
  // それが「基底の淡 accent 地 かつ dark:bg 無し」なら違反とする。
  // ※ hover:/focus: プレフィックスの地色(:直前)や dark:bg-gray-900 済は非該当。
  const darkAccentText = new RegExp(`dark:text-(?:${ACCENT})-(?:200|300|400|500)`);
  const lightAccentBaseBg = new RegExp(`(?:^|[\\s"'])bg-(?:${ACCENT})-(?:50|100|200)`);
  const anyBaseBg = /(?:^|[\s"'])bg-[a-z]/;
  const anyDarkBg = /dark:bg-/;
  const indentOf = (s: string) => (s.match(/^(\s*)/) as RegExpMatchArray)[1].length;

  // 行 idx の文字の「最寄りの背景設定要素」(自身または祖先)が、
  // 淡 accent 地かつ dark:bg 無し なら true。
  const insideLightAccentPanel = (lines: string[], idx: number): boolean => {
    let minIndent = indentOf(lines[idx]) + 1; // 自身を含める
    for (let i = idx; i >= 0 && i > idx - 40; i--) {
      const s = lines[i];
      if (!s.trim()) continue;
      const ind = indentOf(s);
      if (ind < minIndent) {
        if (/className/.test(s) && anyBaseBg.test(s)) {
          return lightAccentBaseBg.test(s) && !anyDarkBg.test(s);
        }
        minIndent = ind;
        if (ind === 0) break;
      }
    }
    return false;
  };

  for (const rel of TOUCHED) {
    it(`${rel}: 淡accent地の箱の中で dark:text-accent を暗色化していない`, () => {
      const lines = read(rel).split("\n");
      const offenders: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (darkAccentText.test(lines[i]) && insideLightAccentPanel(lines, i)) {
          offenders.push(i + 1);
        }
      }
      expect(offenders).toEqual([]);
    });
  }
});
