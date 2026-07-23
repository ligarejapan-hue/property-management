/**
 * 調査ピンのマーカー配色 (Google Maps Pin 用の純ロジック)。
 *
 * 地図上で「種別 4 種 / 対応済み / 自分・他人」を見分けるための出し分け:
 * - 種別ごとの背景色 + 1 文字グリフ (グリフは色覚多様性への冗長表現)
 * - 対応済み (closed) は灰色 + ✓ (物件化済みを含む「もう動かなくてよい」印)
 * - 他人のピンは白縁・自分は濃色縁 (「自分が刺したか」のパッと見判別)
 * - 既存物件マーカーは既定の赤バルーンのまま = ピン側は赤を使わないことで
 *   (調査不可も violet) 物件との混同を避ける
 *
 * 表示専用の純関数のみ (副作用なし・座標や PII を扱わない)。
 */

import { FIELD_SURVEY_PIN_TYPES } from "@/lib/field-survey-constants";

export interface PinMarkerStyle {
  background: string;
  borderColor: string;
  glyphColor: string;
  glyph: string;
}

/** 種別ごとの 1 文字グリフ (凡例と共有)。 */
export const PIN_TYPE_GLYPHS: Record<
  (typeof FIELD_SURVEY_PIN_TYPES)[number],
  string
> = {
  candidate: "候",
  interesting: "確",
  blocked: "不",
  followup: "再",
};

/** 対応済み (closed) のグリフ (凡例と共有)。 */
export const PIN_CLOSED_GLYPH = "✓";

interface PinColors {
  background: string;
  border: string;
}

// 地図タイル (淡色/衛星) の上で沈まない彩度を選ぶ。
// - 背景は白グリフのコントラスト 4.5:1 以上を確保する濃さ (emerald/amber は 700)
// - 「調査不可」は赤にしない: 既定物件マーカーの赤 (#EA4335) とほぼ同色になり
//   ズームアウト・密集時に物件と混同するため violet を使う
const TYPE_COLORS: Record<string, PinColors> = {
  candidate: { background: "#047857", border: "#065F46" }, // emerald-700
  interesting: { background: "#B45309", border: "#92400E" }, // amber-700
  blocked: { background: "#7C3AED", border: "#5B21B6" }, // violet
  followup: { background: "#2563EB", border: "#1E40AF" }, // blue
};

/** 対応済み (closed)。種別によらず「済み」を一目で示す灰色。 */
const CLOSED_COLORS: PinColors = { background: "#6B7280", border: "#374151" };

/** 未知種別のフォールバック (種別追加時に例外で地図を壊さない)。 */
const UNKNOWN_COLORS: PinColors = { background: "#64748B", border: "#334155" };
const UNKNOWN_GLYPH = "・";

export function pinMarkerStyle(input: {
  pinType: string;
  status: string;
  isOwn: boolean;
}): PinMarkerStyle {
  const closed = input.status === "closed";
  const colors = closed
    ? CLOSED_COLORS
    : (TYPE_COLORS[input.pinType] ?? UNKNOWN_COLORS);
  const glyph = closed
    ? PIN_CLOSED_GLYPH
    : ((PIN_TYPE_GLYPHS as Record<string, string>)[input.pinType] ??
      UNKNOWN_GLYPH);
  return {
    background: colors.background,
    // 他人のピンは白縁で「自分のではない」を示す (背景色は種別のまま)。
    borderColor: input.isOwn ? colors.border : "#FFFFFF",
    glyphColor: "#FFFFFF",
    glyph,
  };
}
