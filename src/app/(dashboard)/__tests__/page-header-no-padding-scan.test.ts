/**
 * 画面の題名(PageHeader)までの包みに、余白を付けない(ソース走査)。
 *
 * 背景(実機確認 2026-10-22): 題名の上端が画面ごとに違っていた
 * (ホーム72px・物件一覧80px・巡回履歴84px・査定の申込88px・DMメニュー96px)。
 * 余白は dashboard-layout の <main>(p-4 / lg:p-6)が1回だけ持つ決まりなのに、
 * 一部の画面が自分でも `p-6` などを足し、題名が下と右へずれて見えていた。
 *
 * 走査の境界:
 *  - 見るのは `src/app/(dashboard)` 配下の page.tsx と、題名を別部品に持つ画面
 *    (TITLE_SOURCE と同じ2つ)。
 *  - 各 `return (` から `<PageHeader` が現れるまでの間にある要素の className に、
 *    padding の class(p-N / px-N / py-N / pt-N / pl-N)が無いこと。
 *    PageHeader を含まない return(読み込み中・権限なし等)は見ない。
 *  - 題名より下の余白(内容の枠の p-4 など)は見ない。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

function pages(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "__tests__") continue;
    if (statSync(p).isDirectory()) pages(p, acc);
    else if (name === "page.tsx") acc.push(p);
  }
  return acc;
}

const EXTRA = [
  "src/components/home/HomeContent.tsx",
  "src/components/field-survey/candidate-queue.tsx",
];

const PADDING = /\b(p|px|py|pt|pl)-\d+(\.\d+)?\b/;

/** `return (` から `<PageHeader` までの行のうち、padding を持つ要素の行(純関数)。 */
export function paddedWrappersBeforeHeader(src: string): string[] {
  const lines = src.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*return \($/.test(lines[i])) continue;
    // この return の終わり(`);` だけの行)と、その中の最初の <PageHeader を探す
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*\);?$/.test(lines[j])) { end = j; break; }
    }
    const header = lines.slice(i + 1, end).findIndex((l) => /<PageHeader\b/.test(l));
    if (header < 0) continue; // PageHeader を含まない return(読み込み中・権限なし等)は見ない
    for (let j = i + 1; j < i + 1 + header; j++) {
      const cls = lines[j].match(/className="([^"]*)"/)?.[1];
      if (cls && PADDING.test(cls)) out.push(`${j + 1}: ${lines[j].trim()}`);
    }
  }
  return out;
}

describe("題名(PageHeader)までの包みに余白を付けない", () => {
  const files = [
    ...pages(join(ROOT, "src", "app", "(dashboard)")),
    ...EXTRA.map((p) => join(ROOT, p)),
  ];

  it("対象の画面を列挙できている", () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it("余白つきの包みを持つ画面はゼロ", () => {
    const offenders: Record<string, string[]> = {};
    for (const f of files) {
      const hits = paddedWrappersBeforeHeader(read(f));
      if (hits.length > 0) offenders[f.slice(ROOT.length + 1).split("\\").join("/")] = hits;
    }
    expect(offenders).toEqual({});
  });

  it("純関数の判定: 余白つきの包みを拾い、PageHeader の無い return は見ない", () => {
    const bad = `
  return (
    <div className="p-6">
      <PageHeader title="x" />
    </div>
  );`;
    expect(paddedWrappersBeforeHeader(bad)).toEqual(['3: <div className="p-6">']);
    const loading = `
  return (
    <div className="p-6 text-sm">読み込み中</div>
  );`;
    expect(paddedWrappersBeforeHeader(loading)).toEqual([]);
    const ok = `
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="x" />
      <div className="p-4">本文</div>
    </div>
  );`;
    expect(paddedWrappersBeforeHeader(ok)).toEqual([]);
  });
});
