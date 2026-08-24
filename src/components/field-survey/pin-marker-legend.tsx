"use client";

/**
 * 調査ピンの配色凡例。表示切替パネル内 (調査ピン layer ON 時) に出す。
 * 色とグリフは pinMarkerStyle (純関数) と共有し、凡例と実マーカーが
 * 乖離しないようにする。座標・PII は扱わない。
 */

import { FIELD_SURVEY_PIN_TYPES } from "@/lib/field-survey-constants";
import { formatPinType } from "@/lib/field-survey-pin-util";
import { pinMarkerStyle } from "@/lib/field-survey-pin-marker";
import { propertyMarkerStyle } from "@/lib/field-survey-property-marker";

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
  showPins = true,
  showProperties = true,
}: {
  /**
   * 「白いふちどり = 他の担当者」行を出すか。read_all/manage が無いスタッフ
   * には API が自分のピンしか返さず白縁ピンは一度も出ないため、存在しない
   * 見分け方を案内しない (呼び出し側が権限から判定して渡す)。
   */
  showOthersHint?: boolean;
  /** 調査ピンの行を出すか(ピンのレイヤーが ON のときだけ)。 */
  showPins?: boolean;
  /** 物件の行を出すか(物件のレイヤーが ON のときだけ)。@codex #409 R2 P2 */
  showProperties?: boolean;
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
  const propertySample = propertyMarkerStyle({
    propertyType: "house",
    caseStatus: "new_case",
  });
  const propertyDone = propertyMarkerStyle({
    propertyType: "house",
    caseStatus: "sold",
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
        {showPins &&
          FIELD_SURVEY_PIN_TYPES.map((t) => {
            const s = pinMarkerStyle({ pinType: t, status: "open", isOwn: true });
            return (
              <li key={t} className="flex items-center gap-1.5">
                <LegendChip background={s.background} glyph={s.glyph} />
                <span>{formatPinType(t)}</span>
              </li>
            );
          })}
        {showPins && (
          <li className="flex items-center gap-1.5">
            <LegendChip background={closed.background} glyph={closed.glyph} />
            <span>対応済み・物件化済み</span>
          </li>
        )}
        {showPins && showOthersHint && (
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
        {/* 第3弾: 物件マーカーは全部同じ赤で種別が分からなかった。赤=物件の
            合図は変えず、中の1文字で種別を示す。
            ⚠**物件のレイヤーが ON のときだけ**出す(@codex #409 R2 P2)。
            隠れている層の説明を並べない/出している層の説明を隠さない。 */}
        {showProperties && (
          <>
            <li
              className="flex items-center gap-1.5"
              data-testid="pin-legend-property"
            >
              <LegendChip
                background={propertySample.background}
                glyph={propertySample.glyph}
              />
              <span>赤 = 登録済みの物件(中の文字は種別。土=土地 / 戸=戸建 など)</span>
            </li>
            <li className="flex items-center gap-1.5">
              <LegendChip
                background={propertyDone.background}
                glyph={propertyDone.glyph}
              />
              <span>灰 = 売却済み・終了した物件</span>
            </li>
          </>
        )}
        {/* まとめ表示はピン・物件のどちらにも出るので、どちらか出ていれば説明する。 */}
        {(showPins || showProperties) && (
          <li className="flex items-center gap-1.5">
            <LegendChip background="#6B7280" glyph="12" />
            <span>数字 = この辺りにまとまっている件数(押すと寄って開きます)</span>
          </li>
        )}
      </ul>
    </div>
  );
}
