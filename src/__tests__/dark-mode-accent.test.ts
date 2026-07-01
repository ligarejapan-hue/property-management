import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// src/__tests__ -> src
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

/**
 * 強調色(accent)の暗所コントラスト横断対応の回帰テスト。
 * 方針: 暗面(ページ地=dark:bg-gray-900 等)に「直接」乗る素の accent 文字
 *       (リンク/エラー文/アイコン/アクティブタブ)にのみ add-only で
 *       dark:text-{color}-{300|400} を付与。
 * 対象外(このPRでは触らない/復元済): 淡い accent 地(bg-{color}-50/100/200)の
 *       箱・バッジ・バナー・設定オブジェクトの文字(地色 dark:bg も要る)、
 *       色ロック分類タグ、Google InfoWindow 等の常時ライトなコンテナ内の文字。
 */

// このPRでダーク文字色を追加した(=純変更のある)ファイル群
const TOUCHED = [
  "app/(auth)/login/page.tsx",
  "app/(dashboard)/admin/postal-code-audit/page.tsx",
  "app/(dashboard)/admin/templates/[id]/page.tsx",
  "app/(dashboard)/buildings/[id]/page.tsx",
  "app/(dashboard)/import/page.tsx",
  "app/(dashboard)/import/registry-pdf/page.tsx",
  "app/(dashboard)/properties/[id]/page.tsx",
  "app/(dashboard)/properties/page.tsx",
  "app/(dashboard)/properties/quality-check/page.tsx",
  "components/address/address-lookup-controls.tsx",
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

describe("accent 暗所コントラスト: light-on-light 回帰ガード", () => {
  // 淡い accent 地の「箱」の中の文字を暗色化すると暗モードで淡地×淡文字=不可読。
  // 淡地は【親要素】や【設定オブジェクトの bg:】にあり、dark:text は別行にあることが多い。
  // 次の3経路を検査する(静的解析の限界上、深いネスト/サードパーティ容器は網羅しないが
  //  同一行・設定オブジェクト・要素の祖先の3ケースを押さえる):
  //   (a) 同一行に基底の淡accent地 + dark:text-accent + dark:bg無し
  //   (b) 設定オブジェクト: `text: "…dark:text-accent…"` の兄弟 `bg: "…淡accent…"`(dark:bg無し)
  //   (c) 祖先要素: dark:text-accent の行から遡り、最初に背景を設定する祖先要素の開始タグが
  //       淡accent地 かつ dark:bg無し
  const darkAccentText = new RegExp(`dark:text-(?:${ACCENT})-(?:200|300|400|500)`);
  const lightAccentBg = new RegExp(`(?:^|[\\s"'\`])bg-(?:${ACCENT})-(?:50|100|200)`);
  const anyBaseBg = /(?<!dark:)(?:^|[\s"'`])bg-[a-z]/;
  const anyDarkBg = /dark:bg-/;
  const elementOpen = /<[A-Za-z]/;
  const indentOf = (s: string) => (s.match(/^(\s*)/) as RegExpMatchArray)[1].length;

  // 開始タグのブロック(その行から最初の '>' を含む行まで)を連結して返す
  const tagBlock = (lines: string[], i: number): string => {
    let b = lines[i];
    if (/>/.test(lines[i])) return b;
    for (let k = i + 1; k < lines.length && k < i + 10; k++) {
      b += "\n" + lines[k];
      if (/>/.test(lines[k])) break;
    }
    return b;
  };

  const isLightPanel = (block: string) => lightAccentBg.test(block) && !anyDarkBg.test(block);

  const offendersIn = (src: string): number[] => {
    const lines = src.split("\n");
    const out: number[] = [];
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      if (!darkAccentText.test(line)) continue;

      // (a) same line
      if (anyBaseBg.test(line) && isLightPanel(line)) {
        out.push(idx + 1);
        continue;
      }
      // (b) config object: text: value with a sibling bg: light accent
      if (/^\s*text:\s*["'`]/.test(line)) {
        let flagged = false;
        for (let j = idx - 6; j <= idx + 6; j++) {
          if (j < 0 || j >= lines.length) continue;
          if (/^\s*bg:\s*["'`]/.test(lines[j]) && isLightPanel(lines[j])) {
            flagged = true;
            break;
          }
        }
        if (flagged) {
          out.push(idx + 1);
          continue;
        }
      }
      // (c) nearest bg-setting ancestor element
      const selfIndent = indentOf(line);
      for (let i = idx; i >= 0 && i > idx - 90; i--) {
        const s = lines[i];
        if (i < idx && (indentOf(s) >= selfIndent || !elementOpen.test(s))) continue;
        const block = i === idx ? s : tagBlock(lines, i);
        if (anyBaseBg.test(block)) {
          if (isLightPanel(block)) out.push(idx + 1);
          break; // 最初に背景を設定する祖先で確定
        }
      }
    }
    return out;
  };

  for (const rel of TOUCHED) {
    it(`${rel}: 淡accent地の箱/設定/祖先の中で dark:text-accent を暗色化していない`, () => {
      expect(offendersIn(read(rel))).toEqual([]);
    });
  }
});
