import { z } from "zod";

// 見た目の設定(2026-10-31 発注者指示)。選択肢はここ1か所。増やすときはここと globals.css の [data-theme] を足す。
// theme=色・density=文字サイズ・layout=ナビの位置。個人が未設定(null)なら会社の初期値、それも無ければ DEFAULT_APPEARANCE。

export const THEME_OPTIONS = [
  { value: "auto", label: "自動", hint: "パソコンの設定が明るいならスタンダード、暗いならダーク" },
  { value: "standard", label: "スタンダード", hint: "藍と白・温かみのある灰色" },
  { value: "blue", label: "ブルー", hint: "青と薄い灰色" },
  { value: "dark", label: "ダーク", hint: "暗い背景" },
  { value: "washi", label: "和モダン", hint: "墨と朱・見出しは明朝" },
  { value: "navy", label: "紺と金", hint: "紺のサイドバー" },
  { value: "forest", label: "森", hint: "深い緑" },
  { value: "paper", label: "ウォームペーパー", hint: "生成りの紙の色" },
] as const;

export const DENSITY_OPTIONS = [
  { value: "compact", label: "詰める", hint: "1画面に多く並べる" },
  { value: "normal", label: "標準", hint: "今までの大きさ" },
  { value: "large", label: "大きめ", hint: "読みやすく押しやすい" },
] as const;

export const LAYOUT_OPTIONS = [
  { value: "side", label: "左サイドバー", hint: "今までの配置" },
  { value: "top", label: "上部ナビ", hint: "メニューを上に並べる" },
] as const;

export type ThemePref = (typeof THEME_OPTIONS)[number]["value"];
export type DensityPref = (typeof DENSITY_OPTIONS)[number]["value"];
export type LayoutPref = (typeof LAYOUT_OPTIONS)[number]["value"];
export type Appearance = { theme: ThemePref; density: DensityPref; layout: LayoutPref };

export const DEFAULT_APPEARANCE: Appearance = { theme: "auto", density: "normal", layout: "side" };

const THEMES = THEME_OPTIONS.map((o) => o.value) as [ThemePref, ...ThemePref[]];
const DENSITIES = DENSITY_OPTIONS.map((o) => o.value) as [DensityPref, ...DensityPref[]];
const LAYOUTS = LAYOUT_OPTIONS.map((o) => o.value) as [LayoutPref, ...LayoutPref[]];

const pick = <T extends string>(allowed: readonly T[], ...candidates: unknown[]): T | undefined =>
  candidates.find((c): c is T => typeof c === "string" && (allowed as readonly string[]).includes(c));

type Partialish = { theme?: unknown; density?: unknown; layout?: unknown } | null | undefined;

/**
 * 選べる色テーマ(段階4・管理者の設定 appearance.allowed.themes=カンマ区切り)。将来用で、今は未設定=全部許可。
 * 選択肢に無い値は捨て、一覧の並び順にそろえる。1つも残らなければ全部許可(設定の壊れで誰も選べなくならない)。
 */
export function parseAllowedThemes(value: string | null | undefined): ThemePref[] {
  const listed = new Set((value ?? "").split(",").map((v) => v.trim()));
  const allowed = THEMES.filter((t) => listed.has(t));
  return allowed.length > 0 ? allowed : [...THEMES];
}

/**
 * 個人 → 会社の初期値 → 既定 の順に、選択肢にある最初の値を使う(DB の不正な値では落ちない)。
 * 色は選べる色テーマ(allowedThemes)の中から。どれも許可外なら許可の先頭。
 */
export function resolveAppearance(user: Partialish, company: Partialish, allowedThemes: readonly ThemePref[] = THEMES): Appearance {
  return {
    theme: pick(allowedThemes, user?.theme, company?.theme, DEFAULT_APPEARANCE.theme) ?? allowedThemes[0] ?? DEFAULT_APPEARANCE.theme,
    density: pick(DENSITIES, user?.density, company?.density) ?? DEFAULT_APPEARANCE.density,
    layout: pick(LAYOUTS, user?.layout, company?.layout) ?? DEFAULT_APPEARANCE.layout,
  };
}

/*
 * 画面の切り替えは next-themes(今までのダークモードの仕組み)に乗せる。
 * 今まで「自動/明るい/暗い」を選んでいた人の保存値(system/light/dark)がそのまま 自動/スタンダード/ダーク になる。
 * html には class と data-theme の両方に値が付く(スタンダード=standard・ダーク=dark → dark: が効く)。
 */
export const NEXT_THEMES = ["light", "blue", "dark", "washi", "navy", "forest", "paper"] as const;

export function toNextTheme(theme: ThemePref): string {
  if (theme === "auto") return "system";
  if (theme === "standard") return "light";
  return theme;
}

export function fromNextTheme(value: string | undefined): ThemePref {
  if (value === "system" || value === undefined) return "auto";
  if (value === "light") return "standard";
  return pick(THEMES, value) ?? "auto";
}

/** PATCH /api/me/preferences の本文。null=会社の標準に戻す。1項目以上必須・余計な項目は拒否。 */
export const appearancePatchSchema = z
  .object({
    theme: z.enum(THEMES).nullable().optional(),
    density: z.enum(DENSITIES).nullable().optional(),
    layout: z.enum(LAYOUTS).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "変更する項目がありません" });

export type AppearancePatch = z.infer<typeof appearancePatchSchema>;

/**
 * 管理者が保存する会社の標準(段階4)。3項目は null=既定に戻す(行を消す)。選べる色テーマは1つ以上。
 * 会社の色(null なら既定の「自動」)は選べる色の中に無ければならない(会社の標準が自分で選べない色になるのを防ぐ)。
 */
export const companyAppearanceSchema = z
  .object({
    theme: z.enum(THEMES).nullable(),
    density: z.enum(DENSITIES).nullable(),
    layout: z.enum(LAYOUTS).nullable(),
    allowedThemes: z.array(z.enum(THEMES)).min(1),
  })
  .strict()
  .refine((v) => v.allowedThemes.includes(v.theme ?? DEFAULT_APPEARANCE.theme), {
    message: "会社の標準の色は、選べる色テーマに入れてください",
    path: ["allowedThemes"],
  });

export type CompanyAppearanceInput = z.infer<typeof companyAppearanceSchema>;

/**
 * next-themes の value(テーマ名 → html に付ける値)。**全テーマを書く**: next-themes は書いていないテーマの値を付けず、
 * 切り替え時に外す対象もこの一覧だけになる(前のテーマの印が残る)。スタンダードだけ light → standard。
 */
export const NEXT_THEME_VALUES: Record<string, string> = Object.fromEntries(
  NEXT_THEMES.map((t) => [t, t === "light" ? "standard" : t]),
);
