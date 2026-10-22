/**
 * 実機確認 2026-10-22(別の Claude がブラウザで本番を見た報告・3回目)で分かった小さな直し。
 * 地図の部品は hooks 込みのクライアント部品で SSR できないため、ソース文字列で守る。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

describe("現地調査マップ: 巡回していない時の3ボタンの並びは、狭い画面で左下の現在地ボタンに重ならない(46)", () => {
  const src = read("src/components/field-survey/field-survey-map.tsx");
  // 「巡回していない時の地図下部」の行(trip-quick-start を含む包み)の開きタグ
  const block = src.slice(
    src.indexOf("{!activeSession && !panelOpen && ("),
    src.indexOf('data-testid="trip-quick-start"'),
  );

  it("3つ並ぶとき(撮影の権限あり)は、狭い画面(sm 未満)だけ現在地ボタンの右隣から左詰め+折り返し", () => {
    expect(block).toMatch(
      /cameraButton\.visible[\s\S]{0,200}max-sm:left-\[4\.25rem\] max-sm:right-3 max-sm:translate-x-0 max-sm:flex-wrap/,
    );
  });

  it("sm 以上と、「巡回を開始」だけのときは、これまでどおり中央寄せ(left-1/2 -translate-x-1/2)", () => {
    expect(block).toMatch(/bottom-14 left-1\/2 z-10 flex -translate-x-1\/2 items-start gap-2/);
    // 左詰めは「狭い画面だけ」= max-sm: 無しの left-[…]・right-3・flex-wrap は使わない
    expect(block).not.toMatch(/(?<!max-sm:)(left-\[|right-3|flex-wrap|translate-x-0)/);
  });

  it("現在地ボタン(左下)は left-3 の 48px のまま=右隣 4.25rem(68px) の根拠", () => {
    const fab = read("src/components/field-survey/map-recenter-button.tsx");
    expect(fab).toMatch(/absolute bottom-14 left-3 z-10/);
    expect(fab).toMatch(/h-12 w-12/);
  });
});
