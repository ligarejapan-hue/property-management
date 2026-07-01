import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// src/__tests__ -> src
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

/**
 * 強調色(accent)の暗所コントラスト横断対応の回帰テスト。
 * 方針: 暗面に乗る「素の accent 文字色」(リンク/エラー文/アイコン/アクティブタブ 等)に
 *       add-only で dark:text-{color}-{300|400} を付与。
 * 対象外: 淡い accent 地の上のバッジ/バナー文字(地色も要るので別対応)・色ロック分類タグ。
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

describe("accent 暗所コントラスト: 代表的な素accent文字にdark変種(add-only)", () => {
  it("login: エラー文 text-red-{600,700} と アイコン text-indigo-600 に dark 変種", () => {
    const s = read("app/(auth)/login/page.tsx");
    expect(s).toContain("text-red-600 dark:text-red-400");
    expect(s).toContain("text-red-700 dark:text-red-400");
    expect(s).toContain("text-indigo-600 dark:text-indigo-400");
    // ライト側不変
    expect(s).toContain("text-red-600");
    expect(s).toContain("text-indigo-600");
  });

  it("sidebar: ヘッダーアイコン text-indigo-600 に dark:text-indigo-400", () => {
    expect(read("components/layout/sidebar.tsx")).toContain("text-indigo-600 dark:text-indigo-400");
  });

  it("field-survey-map: 物件リンク text-indigo-600 hover:underline に dark:text-indigo-400", () => {
    expect(read("components/field-survey/field-survey-map.tsx")).toContain(
      "text-indigo-600 hover:underline dark:text-indigo-400",
    );
  });

  it("properties/[id]: アクティブタブ/エラー/警告/成功に dark 変種(素文字のみ)", () => {
    const s = read("app/(dashboard)/properties/[id]/page.tsx");
    expect(s).toContain("text-indigo-600 dark:text-indigo-400"); // active tab
    expect(s).toContain("text-red-700 dark:text-red-400"); // error
    expect(s).toContain("text-amber-800 dark:text-amber-300"); // 素の警告文
    expect(s).toContain("text-green-600 dark:text-green-400"); // save success
    // 注: 淡地バナー/箱の上の accent 文字(bg-amber-50 の警告箱・bg付き棟リンク等)は
    //     地色も要るため今回は対象外(salvageで復元済み)。
  });

  it("properties/page: モバイルカード種別 text-indigo-600 に dark:text-indigo-400", () => {
    expect(read("app/(dashboard)/properties/page.tsx")).toContain(
      "text-indigo-600 dark:text-indigo-400",
    );
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

describe("accent 暗所コントラスト: 淡地の上での light-on-light 回帰ガード", () => {
  // 淡い accent 地(bg-{color}-50/100/200)を「基底背景」に持つ要素の文字だけを
  // 暗色化すると、暗モードで「淡地 × 淡文字」になり読めない。
  // 基底の淡accent地 かつ dark:text-accent かつ 暗背景(dark:bg-*)を一切伴わない行を禁止。
  // ※ hover:/focus: 等のプレフィックス付き accent 地(:直前)や、dark:bg-gray-900 で
  //    面を暗色化済みの正しい要素は対象外。
  const lightAccentBaseBg = new RegExp(`(?:^|[\\s"'])bg-(?:${ACCENT})-(?:50|100|200)`);
  const darkAccentText = new RegExp(`dark:text-(?:${ACCENT})-(?:200|300|400|500)`);
  const anyDarkBg = /dark:bg-/;

  for (const rel of TOUCHED) {
    it(`${rel}: 基底淡accent地 × dark:bg無し × dark:text-accent が無い`, () => {
      const offenders = read(rel)
        .split("\n")
        .map((line, i) => ({ line, i: i + 1 }))
        .filter(
          ({ line }) =>
            lightAccentBaseBg.test(line) && darkAccentText.test(line) && !anyDarkBg.test(line),
        );
      expect(offenders.map((o) => o.i)).toEqual([]);
    });
  }
});
