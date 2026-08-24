/**
 * 物件マーカーの見た目(第3弾)。凡例と地図で同じ関数を使う。
 *
 * ⚠**赤は「物件」を意味する既存の合図**。ピン側のパレット(field-survey-pin-marker.ts)は
 *   「調査不可を赤にしない: 既定物件マーカーの赤とほぼ同色になり、ズームアウト・
 *   密集時に物件と混同する」という理由で意図的に赤を避けている。したがって
 *   物件を種別ごとに多色化すると、この見分けが壊れる。
 *   → **色は赤のまま据え置き、種別は1文字の印で示す**。
 *   → 終わった案件(売却済み・終了)だけ灰色にする。ピンの「対応済み=灰」と
 *     同じ語彙なので、現場は覚え直す必要がない。
 */

/** 種別ごとの1文字の印(凡例と共有)。旧値(building/unit)は現行の近い印に寄せる。 */
export const PROPERTY_TYPE_GLYPHS: Record<string, string> = {
  land: "土",
  house: "戸",
  apartment_unit: "区",
  apartment_building: "棟",
  apartment_block: "ア",
  store: "店",
  office: "事",
  warehouse: "倉",
  factory: "工",
  parking: "P",
  other: "他",
  unknown: "?",
  // 旧値(既存データの編集時にのみ残る選択肢)
  building: "棟",
  unit: "区",
};

/** 終わった案件の印(ピンの「対応済み」と同じ✓)。 */
export const PROPERTY_DONE_GLYPH = "✓";

/**
 * 案件が終わっているとみなす状態。
 * ⚠`done` は廃止された旧値だが**既存データには今も入っている**(新規設定は不可・
 *   正規化では closed 相当)。地図APIは生の caseStatus を返すため、ここで拾わないと
 *   終わった物件が現役の赤で出て状態を誤らせる(@codex #409 R2 P2)。
 */
const DONE_CASE_STATUSES = new Set(["sold", "closed", "done"]);

/**
 * 案件が終わっているか。まとめ表示(クラスタ)も**この同じ規則**を使う
 * (@codex #409 R5 P2)。規則が二重化すると、印と中身の判断がずれる。
 */
export function isPropertyCaseDone(caseStatus?: string | null): boolean {
  return typeof caseStatus === "string" && DONE_CASE_STATUSES.has(caseStatus);
}

/** 未知の種別のフォールバック(種別が増えても地図を壊さない)。 */
const UNKNOWN_GLYPH = "・";

// Google 既定の物件マーカー赤(#EA4335)と同系。白抜き文字のコントラストを
// 確保するため、既定よりわずかに濃い赤を使う。
const ACTIVE_COLORS = { background: "#C5221F", border: "#8C1512" };
// 終わった案件。ピンの CLOSED_COLORS と同じ灰。
const DONE_COLORS = { background: "#6B7280", border: "#374151" };

export interface PropertyMarkerStyle {
  background: string;
  borderColor: string;
  glyphColor: string;
  glyph: string;
}

export function propertyMarkerStyle(input: {
  propertyType?: string | null;
  caseStatus?: string | null;
}): PropertyMarkerStyle {
  const done = isPropertyCaseDone(input.caseStatus);
  const colors = done ? DONE_COLORS : ACTIVE_COLORS;

  const type = typeof input.propertyType === "string" ? input.propertyType.trim() : "";
  const glyph = done
    ? PROPERTY_DONE_GLYPH
    : (PROPERTY_TYPE_GLYPHS[type] ?? UNKNOWN_GLYPH);

  return {
    background: colors.background,
    borderColor: colors.border,
    glyphColor: "#FFFFFF",
    glyph,
  };
}
