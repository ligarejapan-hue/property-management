import { describe, it, expect } from "vitest";
import {
  THEME_OPTIONS,
  DENSITY_OPTIONS,
  LAYOUT_OPTIONS,
  DEFAULT_APPEARANCE,
  resolveAppearance,
  toNextTheme,
  fromNextTheme,
  NEXT_THEMES,
  appearancePatchSchema,
} from "../options";

describe("選択肢の一覧(1か所)", () => {
  it("色テーマは 自動+7つ(発注者決定 2026-10-31)", () => {
    expect(THEME_OPTIONS.map((o) => o.value)).toEqual(["auto", "standard", "blue", "dark", "washi", "navy", "forest", "paper"]);
    expect(THEME_OPTIONS.find((o) => o.value === "washi")?.label).toBe("和モダン");
  });
  it("文字サイズは3つ・レイアウトは2つ", () => {
    expect(DENSITY_OPTIONS.map((o) => o.value)).toEqual(["compact", "normal", "large"]);
    expect(LAYOUT_OPTIONS.map((o) => o.value)).toEqual(["side", "top"]);
  });
  it("初期値 = 自動・標準・左サイドバー", () => {
    expect(DEFAULT_APPEARANCE).toEqual({ theme: "auto", density: "normal", layout: "side" });
  });
});

describe("resolveAppearance: 個人 → 会社の初期値 → 既定 の順", () => {
  it("個人が未設定なら会社の初期値", () => {
    expect(resolveAppearance({ theme: null, density: null, layout: null }, { theme: "navy", density: "large", layout: "top" }))
      .toEqual({ theme: "navy", density: "large", layout: "top" });
  });
  it("個人の設定が勝つ", () => {
    expect(resolveAppearance({ theme: "washi", density: null, layout: null }, { theme: "navy" }))
      .toEqual({ theme: "washi", density: "normal", layout: "side" });
  });
  it("DB に知らない値が入っていても既定に落とす(落ちない)", () => {
    expect(resolveAppearance({ theme: "purple", density: "huge", layout: "x" }, { theme: "nope" })).toEqual(DEFAULT_APPEARANCE);
  });
  it("どちらも無ければ既定", () => {
    expect(resolveAppearance(null, null)).toEqual(DEFAULT_APPEARANCE);
  });
});

describe("画面の切り替え部品(next-themes)との対応", () => {
  it("自動=system・スタンダード=light(今まで「明るい」を選んでいた人はスタンダード)", () => {
    expect(toNextTheme("auto")).toBe("system");
    expect(toNextTheme("standard")).toBe("light");
    expect(toNextTheme("navy")).toBe("navy");
    expect(fromNextTheme("system")).toBe("auto");
    expect(fromNextTheme("light")).toBe("standard");
    expect(fromNextTheme("dark")).toBe("dark");
    expect(fromNextTheme("blue")).toBe("blue");
    expect(fromNextTheme(undefined)).toBe("auto");
    expect(fromNextTheme("unknown")).toBe("auto");
  });
  it("next-themes に渡すテーマ名は system 以外の7つ", () => {
    expect(NEXT_THEMES).toEqual(["light", "blue", "dark", "washi", "navy", "forest", "paper"]);
  });
});

describe("保存の検証(選択肢以外は受け付けない)", () => {
  it("正しい値・null(=会社の標準に戻す)は通る", () => {
    expect(appearancePatchSchema.parse({ theme: "forest" })).toEqual({ theme: "forest" });
    expect(appearancePatchSchema.parse({ theme: null, density: null, layout: null })).toEqual({ theme: null, density: null, layout: null });
  });
  it("知らない値・余計な項目・空は拒否", () => {
    expect(() => appearancePatchSchema.parse({ theme: "purple" })).toThrow();
    expect(() => appearancePatchSchema.parse({ density: "huge" })).toThrow();
    expect(() => appearancePatchSchema.parse({ layout: "bottom" })).toThrow();
    expect(() => appearancePatchSchema.parse({ theme: "navy", role: "admin" })).toThrow();
    expect(() => appearancePatchSchema.parse({})).toThrow();
  });
});

describe("NEXT_THEME_VALUES(html に付ける値)", () => {
  it("7テーマすべてを持ち、スタンダードだけ light → standard", async () => {
    const { NEXT_THEME_VALUES } = await import("../options");
    expect(NEXT_THEME_VALUES).toEqual({
      light: "standard", blue: "blue", dark: "dark", washi: "washi", navy: "navy", forest: "forest", paper: "paper",
    });
  });
});

// 段階4: 会社の設定(管理者)。選べる色テーマの制限は将来用(今は全部許可=未設定)。
describe("parseAllowedThemes: 選べる色テーマ(system_settings の値)", () => {
  it("未設定・空・知らない値だけなら全部許可", async () => {
    const { parseAllowedThemes } = await import("../options");
    const all = THEME_OPTIONS.map((o) => o.value);
    expect(parseAllowedThemes(undefined)).toEqual(all);
    expect(parseAllowedThemes("")).toEqual(all);
    expect(parseAllowedThemes("purple,nope")).toEqual(all);
  });
  it("カンマ区切りの選択肢だけを、一覧の並び順で", async () => {
    const { parseAllowedThemes } = await import("../options");
    expect(parseAllowedThemes("navy, standard,purple,navy")).toEqual(["standard", "navy"]);
  });
});

describe("resolveAppearance: 選べる色テーマの制限", () => {
  it("個人の色が許可されていなければ会社の初期値", () => {
    expect(resolveAppearance({ theme: "washi" }, { theme: "navy" }, ["standard", "navy"]).theme).toBe("navy");
  });
  it("会社の初期値も許可外なら既定、それも許可外なら許可の先頭", () => {
    expect(resolveAppearance({ theme: "washi" }, { theme: "paper" }, ["auto", "navy"]).theme).toBe("auto");
    expect(resolveAppearance({ theme: "washi" }, { theme: "paper" }, ["forest", "navy"]).theme).toBe("forest");
  });
  it("制限を渡さなければ今までどおり", () => {
    expect(resolveAppearance({ theme: "washi" }, null).theme).toBe("washi");
  });
});

describe("companyAppearanceSchema: 管理者が保存する会社の標準", () => {
  it("3項目(null=既定に戻す)と選べる色の一覧を受け付ける", async () => {
    const { companyAppearanceSchema } = await import("../options");
    expect(companyAppearanceSchema.parse({ theme: "navy", density: null, layout: "top", allowedThemes: ["navy", "standard"] }))
      .toEqual({ theme: "navy", density: null, layout: "top", allowedThemes: ["navy", "standard"] });
  });
  it("知らない値・余計な項目・空の一覧・会社の色が選べる色に無いのは拒否", async () => {
    const { companyAppearanceSchema } = await import("../options");
    const ok = { theme: null, density: null, layout: null, allowedThemes: ["auto"] };
    expect(() => companyAppearanceSchema.parse({ ...ok, theme: "purple" })).toThrow();
    expect(() => companyAppearanceSchema.parse({ ...ok, allowedThemes: ["purple"] })).toThrow();
    expect(() => companyAppearanceSchema.parse({ ...ok, allowedThemes: [] })).toThrow();
    expect(() => companyAppearanceSchema.parse({ ...ok, extra: 1 })).toThrow();
    expect(() => companyAppearanceSchema.parse({ ...ok, theme: "navy" })).toThrow();
    // 会社の色が未設定(null=既定の「自動」)なら、自動が選べる色に入っている必要がある
    expect(() => companyAppearanceSchema.parse({ ...ok, allowedThemes: ["navy"] })).toThrow();
  });
});
