import type { ThemePref } from "./options";

// 見た目の設定 段階4(2026-10-31): 設定 > 表示 の「ミニ画面」の見本に使う色。
// 見本は今のテーマと関係なく各テーマの色で描くため、変数ではなく値で持つ(html の変数は今のテーマの値になっている)。
// 5テーマは globals.css の html[data-theme] と同じ値(テストで突き合わせる)。スタンダード・ダークは Tailwind の元の色(16進の近い値)。
// 自動はスタンダードとダークを半分ずつ並べて見せる(画面側)。

export type ThemeSwatch = {
  page: string;
  surface: string;
  line: string;
  text: string;
  muted: string;
  accent: string;
  side: string;
  sideText: string;
  sideActive: string;
};

export const THEME_SWATCHES: Record<Exclude<ThemePref, "auto">, ThemeSwatch> = {
  standard: {
    page: "#fafaf9", surface: "#ffffff", line: "#e7e5e4", text: "#1c1917", muted: "#a6a09b",
    accent: "#4f39f6", side: "#ffffff", sideText: "#44403b", sideActive: "#eef2ff",
  },
  blue: {
    page: "#f6f7f9", surface: "#ffffff", line: "#e3e6ea", text: "#16181d", muted: "#878e99",
    accent: "#2563eb", side: "#ffffff", sideText: "#4a515c", sideActive: "#f1f3f5",
  },
  dark: {
    page: "#0c0a09", surface: "#1c1917", line: "#292524", text: "#f5f5f4", muted: "#a6a09b",
    accent: "#625fff", side: "#1c1917", sideText: "#d6d3d1", sideActive: "#312c85",
  },
  washi: {
    page: "#f4f1ea", surface: "#fbf9f4", line: "#dcd5c8", text: "#1c1a17", muted: "#898175",
    accent: "#b7410e", side: "#1c1a17", sideText: "#bdb5a8", sideActive: "#2a2723",
  },
  navy: {
    page: "#f3f4f7", surface: "#ffffff", line: "#e3e6ea", text: "#16181d", muted: "#848b96",
    accent: "#1e3a8a", side: "#0b1f3a", sideText: "#a9b6cb", sideActive: "#16305a",
  },
  forest: {
    page: "#f2f4f1", surface: "#ffffff", line: "#dce3da", text: "#18221b", muted: "#828e87",
    accent: "#1f5f3a", side: "#16301f", sideText: "#9fb7a6", sideActive: "#24462f",
  },
  paper: {
    page: "#f3eee6", surface: "#fffdf9", line: "#e2d8ca", text: "#2b241e", muted: "#908477",
    accent: "#9a3b12", side: "#ede6db", sideText: "#5a4f45", sideActive: "#fffdf9",
  },
};

/** 文字サイズの見本: html の文字の大きさ(px)。globals.css の html[data-density] と同じ(標準=16px)。 */
export const DENSITY_ROOT_PX = { compact: 14, normal: 16, large: 18.75 } as const;

/** 文字サイズの見本の文(物件一覧に実際に出る形の文字)。 */
export const DENSITY_SAMPLE_TEXT = "目黒区中町 マンション 302号室";
