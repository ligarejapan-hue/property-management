/**
 * 実機確認 2026-10-22(別の Claude がブラウザで本番を見た報告)で分かった小さな直し。
 * 画面の部品は hooks 込みのクライアント部品で SSR できないため、ソース文字列で守る。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

describe("物件詳細の「不動産番号」は値が空なら行を出さない(97)", () => {
  const src = read("src/app/(dashboard)/properties/[id]/page.tsx");

  it("realEstateNumber があるときだけ Field を描く", () => {
    expect(src).toMatch(/property\.realEstateNumber\s*&&\s*\(?\s*<Field label="不動産番号"/);
  });

  it("無条件の <Field label=\"不動産番号\"> は残っていない", () => {
    const lines = src.split("\n");
    const bare = lines.filter(
      (l, i) => l.includes('<Field label="不動産番号"') && !/realEstateNumber\s*&&/.test(lines[i - 1] + l),
    );
    expect(bare).toEqual([]);
  });
});

describe("現地調査マップの「← 完成待ち一覧へ戻る」は Google の地図／航空写真の切替に重ならない(67)", () => {
  const src = read("src/components/field-survey/field-survey-map.tsx");

  it("上部の通知スタックは切替ボタン(上から10px・高さ40px)の下から始まる(top-14=56px)", () => {
    expect(src).toMatch(/absolute left-1\/2 top-14 z-10/);
    expect(src).not.toMatch(/absolute left-1\/2 top-3 z-10/);
  });
});
