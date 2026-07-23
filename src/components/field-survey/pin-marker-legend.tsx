"use client";

/**
 * 調査ピンの配色凡例。表示切替パネル内 (調査ピン layer ON 時) に出す。
 * 色とグリフは pinMarkerStyle (純関数) と共有し、凡例と実マーカーが
 * 乖離しないようにする。座標・PII は扱わない。
 */

import { FIELD_SURVEY_PIN_TYPES } from "@/lib/field-survey-constants";
import { formatPinType } from "@/lib/field-survey-pin-util";
import { pinMarkerStyle } from "@/lib/field-survey-pin-marker";

function LegendChip({
  background,
  glyph,
}: {
  background: string;
  glyph: string;
}) {
  return (
    <span
      aria-hidden="true"
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white"
      style={{ backgroundColor: background }}
    >
      {glyph}
    </span>
  );
}

export default function PinMarkerLegend({
  showOthersHint = false,
}: {
  /**
   * 「白いふちどり = 他の担当者」行を出すか。read_all/manage が無いスタッフ
   * には API が自分のピンしか返さず白縁ピンは一度も出ないため、存在しない
   * 見分け方を案内しない (呼び出し側が権限から判定して渡す)。
   */
  showOthersHint?: boolean;
}) {
  const closed = pinMarkerStyle({
    pinType: "candidate",
    status: "closed",
    isOwn: true,
  });
  const othersSample = pinMarkerStyle({
    pinType: "candidate",
    status: "open",
    isOwn: false,
  });
  return (
    <div
      data-testid="pin-marker-legend"
      className="mb-3 rounded border border-gray-200 bg-gray-50 p-2 dark:border-gray-800 dark:bg-gray-800/40"
    >
      <div className="mb-1 text-[10px] font-semibold text-gray-600 dark:text-gray-300">
        ピンの見かた
      </div>
      <ul className="space-y-1 text-[10px] text-gray-700 dark:text-gray-300">
        {FIELD_SURVEY_PIN_TYPES.map((t) => {
          const s = pinMarkerStyle({ pinType: t, status: "open", isOwn: true });
          return (
            <li key={t} className="flex items-center gap-1.5">
              <LegendChip background={s.background} glyph={s.glyph} />
              <span>{formatPinType(t)}</span>
            </li>
          );
        })}
        <li className="flex items-center gap-1.5">
          <LegendChip background={closed.background} glyph={closed.glyph} />
          <span>対応済み・物件化済み</span>
        </li>
        {showOthersHint && (
          <li
            className="flex items-center gap-1.5 text-gray-500 dark:text-gray-400"
            data-testid="pin-legend-others-hint"
          >
            <span
              aria-hidden="true"
              className="h-4 w-4 shrink-0 rounded-full border-2 shadow-[0_0_0_1px_rgba(0,0,0,0.25)]"
              style={{
                backgroundColor: othersSample.background,
                borderColor: othersSample.borderColor,
              }}
            />
            <span>白いふちどり = 他の担当者のピン</span>
          </li>
        )}
      </ul>
    </div>
  );
}
