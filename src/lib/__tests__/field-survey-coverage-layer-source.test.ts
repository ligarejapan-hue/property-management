/**
 * 踏破ヒートの地図レイヤ / 凡例のソース静的検証 + 凡例 SSR 検証。
 *
 * ここで固定しているのは「見た目」ではなく**壊れると業務が止まる性質**:
 *  - 面が地図タップを奪わないこと（ピン設置・撮影後の場所指定が死ぬ）
 *  - 図形数が段の数で頭打ちになること（50m 格子で数千個描くと端末が固まる）
 *  - 面が最下層に敷かれること（今日の軌跡・現在地が過去の面に隠れない）
 *  - 「色なし = 誰も通っていない」が凡例に書いてあること（唯一の伝達手段）
 *
 * vitest は env=node なので DOM レンダリングは使わず、ソース文字列の表明と
 * renderToStaticMarkup で検証する（既存の *-source.test.ts と同じ流儀）。
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import * as fs from "fs";
import * as path from "path";
import CoverageLegend from "@/components/field-survey/coverage-legend";
import { COVERAGE_HEAT_STYLES, coverageCellLabel } from "@/lib/field-survey-coverage";

function readSrc(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), "utf8");
}

const LAYER_SRC = readSrc("src/components/field-survey/coverage-heat-layer.tsx");
const LEGEND_SRC = readSrc("src/components/field-survey/coverage-legend.tsx");

/** `new Polygon({ ... })` に渡している option ブロック。 */
const POLYGON_OPTIONS = LAYER_SRC.match(/new Polygon\(\{[\s\S]*?\n {8}\}\)/)?.[0];

describe("CoverageHeatLayer — 地図オーバーレイの性質", () => {
  it("Polygon は clickable: false（地図タップをピン設置・撮影後の場所指定に残す）", () => {
    // 面がタップを吸うと「撮って登録」の場所指定ができなくなり致命的。
    expect(POLYGON_OPTIONS).toBeDefined();
    expect(POLYGON_OPTIONS ?? "").toMatch(/clickable:\s*false/);
    expect(POLYGON_OPTIONS ?? "").not.toMatch(/clickable:\s*true/);
  });

  it("zIndex は 0（今日の線・現在地・ピンが過去の面の上に来る）", () => {
    // 過去の線は zIndex:1、今日の線は zIndex:2。ここが 1 以上になると
    // 線が面に埋もれる。
    expect(POLYGON_OPTIONS ?? "").toMatch(/zIndex:\s*0/);
  });

  it("枠線を描かない（50m 格子の枠線は道路名を潰す）", () => {
    expect(POLYGON_OPTIONS ?? "").toMatch(/strokeWeight:\s*0/);
  });

  it("段ごとに 1 枚へ束ねる（1 セル 1 図形にしない）", () => {
    // groupCoverageCellsByTier で段に束ね、各段のセルは 1 枚の Polygon の
    // paths（複数リング）として渡す。生成箇所が 1 つ = 段の数しか作られない。
    expect(LAYER_SRC).toMatch(/groupCoverageCellsByTier\(/);
    expect(LAYER_SRC).toMatch(/for \(const \[tier, tierCells\] of grouped\)/);
    expect(LAYER_SRC).toMatch(/paths:\s*tierCells\.map\(/);
    expect(LAYER_SRC.match(/new Polygon\(/g) ?? []).toHaveLength(1);
    // セルごとに setMap する実装（= 数千オーバーレイ）への退行を禁じる。
    expect(LAYER_SRC).not.toMatch(/cells\.map\([\s\S]{0,200}new Polygon/);
  });

  it("矩形は coverageCellBounds から復元する（サーバの floor 規則と同一）", () => {
    // 独自計算に置き換えると全セルが 1 マスずれる。
    expect(LAYER_SRC).toMatch(/coverageCellBounds\(cell,\s*\{ latStep, lngStep \}\)/);
  });

  it("AdvancedMarker を 1 つも使わない（既存テストがマーカー個数を固定している）", () => {
    // コメント中の言及は許し、実使用（JSX タグ / import）だけを禁じる。
    for (const src of [LAYER_SRC, LEGEND_SRC]) {
      expect(src).not.toMatch(/<AdvancedMarker/);
      expect(src).not.toMatch(/import\s*\{[^}]*AdvancedMarker/);
    }
    // 面だけを敷き、DOM ノードも増やさない。
    expect(LAYER_SRC).toMatch(/return null;/);
  });

  it("route-polyline と同じ流儀（未ロードなら描かず、cleanup で setMap(null)）", () => {
    expect(LAYER_SRC).toMatch(/useMap\(\)/);
    expect(LAYER_SRC).toMatch(/globalThis as unknown as \{ google\?/);
    expect(LAYER_SRC).toMatch(/if \(!Polygon\) return;/);
    expect(LAYER_SRC).toMatch(/polygon\.setMap\(null\)/);
    // visible=false で 1 枚も残さない。
    expect(LAYER_SRC).toMatch(/if \(!visible\) return;/);
  });

  it("色は COVERAGE_HEAT_STYLES から引き、直書きしない", () => {
    expect(LAYER_SRC).toMatch(/COVERAGE_HEAT_STYLES\[tier\]/);
    expect(LAYER_SRC).toMatch(/fillColor:\s*style\.fillColor/);
    expect(LAYER_SRC).toMatch(/fillOpacity:\s*style\.fillOpacity/);
    expect(LAYER_SRC).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/);
  });

  it("座標・PII をログに出さない", () => {
    expect(LAYER_SRC).not.toMatch(/console\./);
    expect(LEGEND_SRC).not.toMatch(/console\./);
  });
});

describe("CoverageLegend — ソース", () => {
  it("色を直書きせず COVERAGE_HEAT_STYLES から生成する", () => {
    // 地図の塗りだけ変えたときに凡例が嘘をつくのを防ぐ。
    expect(LEGEND_SRC).toMatch(/COVERAGE_HEAT_STYLES/);
    expect(LEGEND_SRC).toMatch(/backgroundColor:\s*style\.fillColor/);
    expect(LEGEND_SRC).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/);
  });

  it("タップ対象を作らない（表示のみ）", () => {
    expect(LEGEND_SRC).not.toMatch(/<button|<a\s|onClick|role="button"/);
  });

  it("ダークモード配色を持ち、座標や PII を扱わない", () => {
    expect(LEGEND_SRC).toMatch(/dark:/);
    expect(LEGEND_SRC).not.toMatch(/staffUserId|memo|\blat\b|\blng\b/);
  });
});

describe("CoverageLegend — SSR", () => {
  const html = renderToStaticMarkup(createElement(CoverageLegend));
  const htmlWithCell = renderToStaticMarkup(
    createElement(CoverageLegend, { cellSize: "fine" as const }),
  );

  it("4 段 + 「色なし」の 5 行を出す", () => {
    // 段の数が減る/「色なし」行が消える退行を検出する。
    const rows = html.match(/data-testid="coverage-legend-row"/g) ?? [];
    expect(rows).toHaveLength(5);
  });

  it("各段の回数と説明が COVERAGE_HEAT_STYLES どおりに出る", () => {
    for (const tier of [1, 2, 3, 4] as const) {
      expect(html).toContain(COVERAGE_HEAT_STYLES[tier].countLabel);
      expect(html).toContain(COVERAGE_HEAT_STYLES[tier].label);
    }
    // 色見本も表と同じ値（大文字小文字は React の出力に依存しないよう吸収）。
    const lower = html.toLowerCase();
    for (const tier of [1, 2, 3, 4] as const) {
      expect(lower).toContain(COVERAGE_HEAT_STYLES[tier].fillColor.toLowerCase());
    }
  });

  it("「色なし = 誰も通っていない」を必ず含む", () => {
    // 未踏破をグレーで塗らない代わりの、唯一の伝達手段。
    expect(html).toContain("色なし");
    expect(html).toContain("誰も通っていません");
  });

  it("cellSize を渡すと 1 マスの実寸を出す（渡さなければ出さない）", () => {
    expect(htmlWithCell).toContain(coverageCellLabel("fine"));
    expect(htmlWithCell).toContain("1マス");
    expect(html).not.toContain("1マス");
  });
});
