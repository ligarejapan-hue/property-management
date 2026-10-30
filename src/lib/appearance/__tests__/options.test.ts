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
