/**
 * UI一貫性 第2弾 (発注者承認 2026-08-23) の再発防止走査。
 *  ⑧ ページ見出しは PageHeader(手書き h1 を増やさない)
 *  ⑨ ページ送りは Pagination(手書き 前へ/次へ・件数表示を増やさない)
 *  ⑩ 戻る導線は「← ◯◯へ戻る」(「に戻る」を増やさない)
 *  ② 検索窓は SearchField(生の検索 input を増やさない)
 *
 * 逆行(部品を使わない手書きの追加)は**ファイル名指し**で落ちる。
 * allow-list は「なぜ許すか」を1行で書く(理由なしの追加はレビューで弾く)。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const APP = join(process.cwd(), "src", "app");

/** src/app 配下の .tsx を列挙(生成物/テストは除外)。 */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "__tests__") continue;
      walk(full, out);
    } else if (/\.tsx$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(APP);
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const rel = (p: string) => relative(process.cwd(), p).replace(/\\/g, "/");

/** コメント(// と JSXの中括弧コメント)を除いた本文。文言走査の誤検知防止。 */
function withoutComments(src: string): string {
  return src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("(⑨) ページ送りの手書き禁止", () => {
  it("「前へ」「次へ」を両方含むページは Pagination を使う", () => {
    // cursor 方式(totalPages が無い)は数値モデルの部品に載らないため許す。
    const ALLOW = new Set([
      "src/app/(dashboard)/admin/owners/correction/page.tsx", // cursor方式
    ]);
    const offenders = files.filter((f) => {
      const s = read(f);
      return (
        s.includes("前へ") &&
        s.includes("次へ") &&
        !s.includes('from "@/components/ui/pagination"') &&
        !ALLOW.has(rel(f))
      );
    });
    expect(offenders.map(rel), "手書きページ送りが増えた").toEqual([]);
  });

  it("件数表示「件中」の手書きを増やさない(Pagination が唯一の書式)", () => {
    // 非ページ送りの件数文(選択数・集計)だけ許す。
    const ALLOW = new Set([
      "src/app/(dashboard)/admin/owners/correction/page.tsx", // 一括反映の選択数
      "src/app/(dashboard)/properties/quality-check/page.tsx", // 品質集計の説明文
    ]);
    const offenders = files.filter((f) => {
      const s = withoutComments(read(f));
      return (
        s.includes("件中") &&
        !s.includes('from "@/components/ui/pagination"') &&
        !ALLOW.has(rel(f))
      );
    });
    expect(offenders.map(rel), "件数表示の手書きが増えた").toEqual([]);
  });
});

describe("(⑧) ページ見出しの手書き禁止", () => {
  it("dashboard の page.tsx に生の <h1 を増やさない(PageHeader を使う)", () => {
    const ALLOW = new Set([
      // コンパクトな地図ツールバーの見出し。PageHeader の既定寸(text-2xl+mb-6)は
      // h-[calc(100dvh-3.5rem)] で高さを切り詰めた地図表示領域を圧迫するため対象外。
      "src/app/(dashboard)/field-survey/map/page.tsx",
    ]);
    const offenders = files.filter(
      (f) =>
        /\(dashboard\)/.test(f.replace(/\\/g, "/")) &&
        /page\.tsx$/.test(f) &&
        read(f).includes("<h1") &&
        !ALLOW.has(rel(f)),
    );
    expect(offenders.map(rel), "生の h1 が増えた(PageHeader を使う)").toEqual([]);
  });
});

describe("(⑩) 戻る文言の統一", () => {
  it("「に戻る」を JSX に増やさない(BackLink の「◯◯へ戻る」に統一)", () => {
    const offenders = files.filter((f) =>
      /に戻る/.test(withoutComments(read(f)).replace(/元に戻す/g, "")),
    );
    expect(offenders.map(rel), "「に戻る」が増えた(「へ戻る」=BackLink)").toEqual([]);
  });
});

describe("(②) 検索窓の手書き禁止", () => {
  it("検索 placeholder の生 <input を増やさない(SearchField を使う)", () => {
    const ALLOW = new Set([
      // 統合検索窓(第1弾①)は分類・保留の独自ロジックを持つ専用実装。
      "src/app/(dashboard)/properties/page.tsx",
      // ウィザード内の既存物件 picker(候補リスト直結)。一覧の絞り込みではない。
      "src/app/(dashboard)/import/registry-pdf/page.tsx",
    ]);
    const offenders = files.filter((f) => {
      const s = read(f);
      return (
        /<input[^>]*placeholder="[^"]*検索/.test(s) && !ALLOW.has(rel(f))
      );
    });
    expect(offenders.map(rel), "生の検索 input が増えた(SearchField を使う)").toEqual(
      [],
    );
  });
});

describe("部品の存在", () => {
  it.each(["pagination", "page-header", "back-link", "filter-panel", "search-field"])(
    "src/components/ui/%s.tsx が存在する",
    (name) => {
      expect(() =>
        readFileSync(join(process.cwd(), "src", "components", "ui", `${name}.tsx`)),
      ).not.toThrow();
    },
  );
});
