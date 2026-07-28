"use client";

/**
 * 踏破ヒート（歩いた場所の蓄積）の凡例。表示切替パネル内（踏破ヒート ON 時）に出す。
 *
 * 色は必ず `COVERAGE_HEAT_STYLES` から引く。凡例に色を直書きすると、地図の塗りだけ
 * 変えたときに凡例が嘘をつく（= 未踏破の判断を誤らせる）。
 *
 * ⚠**「色なし = この期間に誰も通っていません」の行を必ず出す**。
 * 未踏破をグレーで塗ると地図が読めなくなるので塗らない方針にした結果、
 * 「色が無い」ことの意味を伝える手段はこの凡例しかない。
 *
 * 表示のみ。タップ対象（ボタン/リンク）を作らない
 *（パネル内で押せる物が増えると、地図操作の邪魔になる）。
 * 座標・PII は扱わない。
 */

import {
  COVERAGE_HEAT_STYLES,
  coverageCellLabel,
  type CoverageCellSize,
  type CoverageHeatTier,
} from "@/lib/field-survey-coverage";

/**
 * 段の並び。段が増減しても凡例が自動で追随するよう、配列を持たずに
 * スタイル表のキーから導出する（薄い順に並べる）。
 */
const HEAT_TIERS: CoverageHeatTier[] = Object.keys(COVERAGE_HEAT_STYLES)
  .map((key) => Number(key) as CoverageHeatTier)
  .sort((a, b) => a - b);

/**
 * 色見本。
 *
 * ⚠下地を白で固定するのは、地図（Google マップ標準の道路地図）が
 * ダークモードでも明るいまま = 実際の見え方が「白い地図の上に半透明の色」だから。
 * 凡例の下地をパネル色に合わせると、地図上の色と別物に見えてしまう。
 */
function LegendSwatch({ tier }: { tier?: CoverageHeatTier }) {
  const style = tier === undefined ? null : COVERAGE_HEAT_STYLES[tier];
  return (
    <span
      aria-hidden="true"
      className="flex h-4 w-6 shrink-0 overflow-hidden rounded-sm bg-white ring-1 ring-gray-300 dark:ring-gray-600"
    >
      {style && (
        <span
          className="h-full w-full"
          style={{
            backgroundColor: style.fillColor,
            opacity: style.fillOpacity,
          }}
        />
      )}
    </span>
  );
}

export default function CoverageLegend({
  cellSize,
}: {
  /**
   * 表示中の格子の粗さ。渡すと「1マス 約50m」の実寸を出す。
   * 粗さは寄り引きで自動的に変わるので、いま見ている色が
   * どれくらいの範囲を表すのかを添える。
   */
  cellSize?: CoverageCellSize;
}) {
  return (
    <div
      data-testid="coverage-legend"
      className="mb-3 rounded border border-gray-200 bg-gray-50 p-2 dark:border-gray-800 dark:bg-gray-800/40"
    >
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-semibold text-gray-600 dark:text-gray-300">
          歩いた回数（全員の合計）
        </span>
        {cellSize && (
          <span
            data-testid="coverage-legend-cell-size"
            className="text-[10px] text-gray-500 dark:text-gray-400"
          >
            1マス {coverageCellLabel(cellSize)}
          </span>
        )}
      </div>
      <ul className="space-y-1 text-[10px] text-gray-700 dark:text-gray-300">
        {HEAT_TIERS.map((tier) => (
          <li key={tier} data-testid="coverage-legend-row" className="flex items-center gap-1.5">
            <LegendSwatch tier={tier} />
            <span className="w-12 shrink-0">{COVERAGE_HEAT_STYLES[tier].countLabel}</span>
            <span className="text-gray-500 dark:text-gray-400">
              {COVERAGE_HEAT_STYLES[tier].label}
            </span>
          </li>
        ))}
        {/* 未踏破は塗らない方針なので、意味はこの行でしか伝えられない。 */}
        <li data-testid="coverage-legend-row" className="flex items-center gap-1.5">
          <LegendSwatch />
          <span className="w-12 shrink-0">色なし</span>
          <span className="text-gray-500 dark:text-gray-400">この期間に誰も通っていません</span>
        </li>
      </ul>
    </div>
  );
}
