import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemePreview, DensityPreview, LayoutPreview } from "../display-previews";
import { ChoiceCard } from "../display-settings";
import { THEME_SWATCHES } from "@/lib/appearance/swatches";

// 見た目の設定 段階4(2026-10-31): 設定 > 表示。見本は描画で、操作(保存・反映)はソースの決まりで確かめる(vitest は node)。
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const settings = read("src/components/settings/display-settings.tsx");
const page = read("src/app/(dashboard)/settings/display/page.tsx");
const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
const hasColor = (html: string, hex: string) => html.includes(hex) || html.includes(rgb(hex));

describe("見本(ミニ画面・文字・配置)", () => {
  it("色の見本はそのテーマの色の値で描く(今のテーマの変数を使わない)", () => {
    const html = renderToStaticMarkup(<ThemePreview theme="navy" />);
    expect(hasColor(html, THEME_SWATCHES.navy.side)).toBe(true);
    expect(hasColor(html, THEME_SWATCHES.navy.accent)).toBe(true);
    expect(html).toContain('aria-hidden="true"');
  });
  it("自動はスタンダードとダークを並べる", () => {
    const html = renderToStaticMarkup(<ThemePreview theme="auto" />);
    expect(hasColor(html, THEME_SWATCHES.standard.page)).toBe(true);
    expect(hasColor(html, THEME_SWATCHES.dark.page)).toBe(true);
  });
  it("文字の見本は実際の物件の文字で、その設定の大きさ(px)", () => {
    const compact = renderToStaticMarkup(<DensityPreview density="compact" />);
    const large = renderToStaticMarkup(<DensityPreview density="large" />);
    expect(compact).toContain("目黒区中町 マンション 302号室");
    expect(compact).toContain("font-size:12.25px");
    expect(large).toContain("font-size:16.40625px");
  });
  it("配置の見本は左と上で形が違う", () => {
    expect(renderToStaticMarkup(<LayoutPreview layout="side" />)).toContain("border-r");
    expect(renderToStaticMarkup(<LayoutPreview layout="top" />)).toContain("border-b");
  });
});

describe("選択肢 = 本物のラジオボタン(キーボードの矢印で選べる)", () => {
  it("同じ名前のラジオ・選ばれているものに checked と枠の色・キーボードで選んだときの枠", () => {
    const html = renderToStaticMarkup(
      <ChoiceCard name="theme" value="navy" checked label="紺と金" hint="紺のサイドバー" preview={null} onSelect={() => {}} />,
    );
    const input = html.match(/<input[^>]*>/)?.[0] ?? "";
    for (const a of ['type="radio"', 'name="theme"', 'value="navy"', 'checked=""']) expect(input).toContain(a);
    expect(html).toContain("border-accent");
    expect(html).toContain("has-[:focus-visible]:outline-2");
    expect(html).toContain("紺と金");
    const off = renderToStaticMarkup(
      <ChoiceCard name="theme" value="forest" checked={false} label="森" preview={null} onSelect={() => {}} />,
    );
    expect(off).not.toContain("checked");
  });
  it("3つの設定はそれぞれ fieldset と見出し(legend)でまとまる", () => {
    expect(settings).toContain("<fieldset");
    expect(settings).toContain("<legend");
    for (const t of ['title="色テーマ"', 'title="文字サイズ"', 'title="メニューの配置"']) expect(settings).toContain(t);
  });
});

describe("押した瞬間に反映・保存は自動", () => {
  it("色=setTheme・文字=applyDensity・配置=applyLayout で反映してから保存する", () => {
    expect(settings).toMatch(/setTheme\(toNextTheme\(v as ThemePref\)\);\s*void save\(\{ theme: v as ThemePref \}\)/);
    expect(settings).toMatch(/applyDensity\(v as DensityPref\);\s*void save\(\{ density: v as DensityPref \}\)/);
    expect(settings).toMatch(/applyLayout\(v as LayoutPref\);\s*void save\(\{ layout: v as LayoutPref \}\)/);
  });
  it("「保存しました」を小さく出す(読み上げにも届く)・失敗は消さずに知らせる", () => {
    expect(settings).toContain('role="status" aria-live="polite"');
    expect(settings).toContain('text: "保存しました"');
    expect(settings).toMatch(/if \(s\?\.kind === "ok"\) timer\.current = setTimeout/);
  });
  it("「会社の標準に戻す」= 3つとも null を保存して、保存後の実際の値で描き直す", () => {
    expect(settings).toContain("会社の標準に戻す");
    expect(settings).toContain("save({ theme: null, density: null, layout: null })");
    expect(settings).toContain("applyAll(saved.effective)");
  });
  it("続けて選んだとき、古い保存の応答で表示を上書きしない", () => {
    expect(settings).toContain("const seq = ++saveSeq.current;");
    expect(settings).toContain("if (seq !== saveSeq.current) return null;");
  });
  it("「会社の標準に戻す」の応答も、後の選択があれば反映しない(save が null)", () => {
    expect(settings).toMatch(/const saved = await save\(\{ theme: null, density: null, layout: null \}\);\s*if \(saved\) applyAll/);
  });
  it("利用者メニューなど別の場所での保存に追随する(戻すボタンが押せないまま、を防ぐ)", () => {
    expect(settings).toContain("window.addEventListener(PREFERENCES_SAVED_EVENT, onSaved)");
    expect(settings).toContain("window.removeEventListener(PREFERENCES_SAVED_EVENT, onSaved)");
  });
  it("色は会社が選べる色だけを出す", () => {
    expect(settings).toContain("THEME_OPTIONS.filter((o) => allowed.includes(o.value))");
  });
  it("動きを減らす設定では枠の色の変化も止める", () => {
    expect(settings).toContain("motion-reduce:transition-none");
  });
});

describe("会社の標準(管理者だけ)", () => {
  it("canEditCompany のときだけ出し、保存は管理者用の口へ(権限はサーバーで改めて確かめる)", () => {
    expect(settings).toContain("prefs?.canEditCompany && <CompanyDefaults");
    expect(settings).toContain('fetch("/api/admin/appearance-defaults"');
    expect(settings).toContain('method: "PUT"');
  });
  it("選べる色が空・会社の色が選べる色に無いときは保存できない(サーバーの検証と同じ)", () => {
    expect(settings).toContain("const invalid = allowed.length === 0 || !allowed.includes(companyTheme);");
    expect(settings).toContain("disabled={saving || invalid}");
  });
});

describe("ページ", () => {
  it("題名は共通の PageHeader・中身は DisplaySettings", () => {
    expect(page).toContain('<PageHeader title="表示の設定"');
    expect(page).toContain("<DisplaySettings />");
  });
});
