/**
 * dev限定 テーマ調整ツールの純粋ロジック（DOM非依存・テスト対象）。
 *
 * アプリの実トークン（globals.css の :root / @theme）を基準値に持ち、
 * スライダー入力（色相シフト・彩度倍率・角丸倍率など）から
 * 「実行時に上書きする CSS 変数」と「globals.css へ貼り付ける CSS」を生成する。
 *
 * 既定値（shift 0 / scale 1 等）では globals.css の現状と完全一致する＝
 * パネルを開いただけでは見た目が変わらない。
 */

/** ライト/ダーク各モードの基本色。 */
export interface ColorPair {
  bg: string;
  fg: string;
}

/** 調整ツールの状態（localStorage 保存対象）。 */
export interface TunerState {
  light: ColorPair;
  dark: ColorPair;
  /** グレー階調の色相を一律シフト（度） */
  grayHueShift: number;
  /** グレー階調の彩度を一律倍率（0 で無彩色） */
  grayChromaScale: number;
  /** 角丸スケール倍率（1 で Tailwind 既定） */
  radiusScale: number;
  /** 余白の基準（rem・Tailwind の --spacing） */
  spacing: number;
  /** 基本文字サイズ（px） */
  fontSize: number;
}

/** Tailwind のグレー段（50〜950）。 */
export const GRAY_STOPS = [
  50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950,
] as const;

interface GrayBaseEntry {
  /** lightness（%） */
  l: number;
  /** chroma */
  c: number;
  /** hue（度） */
  h: number;
}

/**
 * globals.css の @theme `--color-gray-*` と完全一致する基準値（暖色 stone）。
 * ここを動かさない限り出力はアプリ現状と一致する。
 */
const GRAY_BASELINE: readonly GrayBaseEntry[] = [
  { l: 98.5, c: 0.001, h: 106.423 },
  { l: 97, c: 0.001, h: 106.424 },
  { l: 92.3, c: 0.003, h: 48.717 },
  { l: 86.9, c: 0.005, h: 56.366 },
  { l: 70.9, c: 0.01, h: 56.259 },
  { l: 55.3, c: 0.013, h: 58.071 },
  { l: 44.4, c: 0.011, h: 73.639 },
  { l: 37.4, c: 0.01, h: 67.558 },
  { l: 26.8, c: 0.007, h: 34.298 },
  { l: 21.6, c: 0.006, h: 56.043 },
  { l: 14.7, c: 0.004, h: 49.25 },
];

export type RadiusKey = "xs" | "sm" | "md" | "lg" | "xl" | "2xl" | "3xl";

/** Tailwind v4 の radius 既定値（rem）。 */
const RADIUS_BASELINE: Record<RadiusKey, number> = {
  xs: 0.125,
  sm: 0.25,
  md: 0.375,
  lg: 0.5,
  xl: 0.75,
  "2xl": 1,
  "3xl": 1.5,
};

/** アプリ現状＝調整ツールの初期値（「現在値に戻す」の基準）。 */
export const DEFAULT_TUNER_STATE: TunerState = {
  light: { bg: "#ffffff", fg: "#171717" },
  dark: { bg: "#0a0a0a", fg: "#ededed" },
  grayHueShift: 0,
  grayChromaScale: 1,
  radiusScale: 1,
  spacing: 0.25,
  fontSize: 16,
};

/** 数値を「末尾ゼロを残さない」文字列にする（97 → "97" / 98.5 → "98.5"）。 */
function num(value: number, decimals: number): string {
  return Number(value.toFixed(decimals)).toString();
}

/**
 * HEX 文字列を確定可能なら 6 桁小文字へ正規化（不可なら null）。
 * 3 桁ショートハンド（#abc）は 6 桁（#aabbcc）へ展開する。
 * `<input type="color">` は #rrggbb のみ受理するため、確定値は常に 6 桁へ揃え、
 * テキスト欄とカラーピッカーの不整合を防ぐ。
 */
export function normalizeHexColor(input: string): string | null {
  const v = input.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  if (short) {
    const [, r, g, b] = short;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return /^#[0-9a-f]{6}$/.test(v) ? v : null;
}

/**
 * グレー階調 11 段を OKLCH 文字列で生成。
 * 既定（hueShift 0 / chromaScale 1）で globals.css の値と完全一致する。
 */
export function buildGrayScale(hueShift: number, chromaScale: number): string[] {
  return GRAY_BASELINE.map(({ l, c, h }) => {
    const chroma = Math.max(0, c * chromaScale);
    const hue = (((h + hueShift) % 360) + 360) % 360;
    return `oklch(${num(l, 3)}% ${num(chroma, 4)} ${num(hue, 3)})`;
  });
}

/** radius 各トークンを倍率で拡縮した rem 値を返す。 */
export function buildRadiusScale(multiplier: number): Record<RadiusKey, number> {
  const out = {} as Record<RadiusKey, number>;
  (Object.keys(RADIUS_BASELINE) as RadiusKey[]).forEach((key) => {
    out[key] = Number((RADIUS_BASELINE[key] * multiplier).toFixed(3));
  });
  return out;
}

/**
 * 実行時に documentElement へ流し込む CSS 変数のマップを生成。
 * mode 側の bg/fg を適用するため、ライブプレビューでモード切替に追従する。
 */
export function buildCssVariables(
  state: TunerState,
  mode: "light" | "dark",
): Record<string, string> {
  const vars: Record<string, string> = {};
  const colors = state[mode];
  vars["--background"] = colors.bg;
  vars["--foreground"] = colors.fg;

  const gray = buildGrayScale(state.grayHueShift, state.grayChromaScale);
  GRAY_STOPS.forEach((stop, i) => {
    vars[`--color-gray-${stop}`] = gray[i];
  });

  const radius = buildRadiusScale(state.radiusScale);
  (Object.keys(radius) as RadiusKey[]).forEach((key) => {
    vars[`--radius-${key}`] = `${radius[key]}rem`;
  });

  vars["--spacing"] = `${state.spacing}rem`;
  return vars;
}

/** globals.css に貼り付けるための CSS ブロックを生成（自動反映はしない）。 */
export function buildExportCss(state: TunerState): string {
  const gray = buildGrayScale(state.grayHueShift, state.grayChromaScale);
  const radius = buildRadiusScale(state.radiusScale);
  const grayLines = GRAY_STOPS.map(
    (stop, i) => `  --color-gray-${stop}: ${gray[i]};`,
  ).join("\n");
  const radiusLines = (Object.keys(radius) as RadiusKey[])
    .map((key) => `  --radius-${key}: ${radius[key]}rem;`)
    .join("\n");
  // 文字サイズは「既定(16px)から変えた時だけ」出力する。常に :root へ font-size を
  // 焼き込むと、ユーザーのブラウザ既定フォントサイズ（アクセシビリティ設定）を上書きし、
  // globals.css の現状（root font-size 無し）とも乖離するため。
  const fontSizeLine =
    state.fontSize !== DEFAULT_TUNER_STATE.fontSize
      ? `\n  /* 基本文字サイズ（rem基準＝全体に影響・任意） */\n  font-size: ${state.fontSize}px;`
      : "";

  return `/* テーマ調整ツールの出力 — src/app/globals.css に反映してください（自動反映なし） */
:root {
  --background: ${state.light.bg};
  --foreground: ${state.light.fg};${fontSizeLine}
}

.dark {
  --background: ${state.dark.bg};
  --foreground: ${state.dark.fg};
}

@theme {
  /* グレー階調（暖色ストーン調・OKLCH） */
${grayLines}

  /* 余白の基準（Tailwind の spacing 全体に効く・既定 0.25rem） */
  --spacing: ${state.spacing}rem;

  /* 角丸スケール（rounded-* 全体に効く・新規上書き／任意）
     注: 素の rounded は Tailwind v4 では 0.25rem 固定リテラルのため調整対象外。
     rounded-md / rounded-lg / rounded-xl 等は反映されます。 */
${radiusLines}
}
`;
}
