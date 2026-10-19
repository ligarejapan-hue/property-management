/**
 * 共通ボタン (UI一貫性 第1弾 ③) の仕様固定。
 * env=node のため renderToStaticMarkup で SSR 検証する。
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "../button";

const html = (props: Record<string, unknown>, child = "実行") =>
  renderToStaticMarkup(createElement(Button, props, child));

describe("Button", () => {
  it("既定 = primary / md / type=button", () => {
    const out = html({});
    expect(out).toContain("bg-indigo-600");
    expect(out).toContain("px-4 py-2 text-sm");
    expect(out).toContain('type="button"');
    expect(out).toContain("rounded-md");
  });

  it("⚠type を明示しない限り submit にならない(form 内の誤送信防止)", () => {
    expect(html({})).not.toContain('type="submit"');
    expect(html({ type: "submit" })).toContain('type="submit"');
  });

  it("secondary は枠線+ダーク配色を持つ", () => {
    const out = html({ variant: "secondary" });
    expect(out).toContain("border-gray-300");
    expect(out).toContain("dark:bg-gray-900");
    expect(out).not.toContain("bg-indigo-600");
  });

  it("danger は赤", () => {
    const out = html({ variant: "danger" });
    expect(out).toContain("bg-red-600");
  });

  it("sm は px-3 py-1.5 text-xs", () => {
    expect(html({ size: "sm" })).toContain("px-3 py-1.5 text-xs");
  });

  it("disabled の見た目(押せない理由は title で伝える運用)", () => {
    const out = html({ disabled: true, title: "選択がありません" });
    expect(out).toContain("disabled");
    expect(out).toContain("disabled:opacity-60");
    expect(out).toContain('title="選択がありません"');
  });

  it("className の追加は既定を消さない(併記)", () => {
    const out = html({ className: "w-full" });
    expect(out).toContain("bg-indigo-600");
    expect(out).toContain("w-full");
  });

  // ── UIの統一 第2回(2026-10-19): 影・ghost・lg・処理中/完了 ──
  it("primary は薄い影・乗せると濃く(押せないときは影なし)", () => {
    const out = html({});
    expect(out).toContain("shadow-xs");
    expect(out).toContain("hover:shadow-sm");
    expect(out).toContain("disabled:shadow-none");
    expect(html({ variant: "secondary" })).not.toContain("shadow-xs");
  });

  it("ghost = 枠なし・乗せると薄い灰", () => {
    const out = html({ variant: "ghost" });
    expect(out).toContain("bg-transparent");
    expect(out).toContain("hover:bg-gray-100");
    expect(out).toContain("dark:hover:bg-gray-800");
    expect(out).not.toContain("bg-indigo-600");
  });

  it("lg = スマホの主操作(高さ44px以上)", () => {
    const out = html({ size: "lg" });
    expect(out).toContain("min-h-11");
    expect(out).toContain("px-5");
  });

  it("loading: くるくる+文言・押せない・aria-busy・元の文言は幅を保つため invisible で残す", () => {
    const out = html({ loading: true }, "保存する");
    expect(out).toContain("animate-spin");
    expect(out).toContain("処理中");
    expect(out).toContain("disabled");
    expect(out).toContain('aria-busy="true"');
    expect(out).toMatch(/<span class="invisible"[^>]*>保存する<\/span>/);
  });

  it("loadingLabel を差し替えられる", () => {
    const out = html({ loading: true, loadingLabel: "保存中" }, "保存する");
    expect(out).toMatch(/>保存中</);
    expect(out).not.toContain("loadingLabel");
    expect(out).not.toContain("loadinglabel");
  });

  it("done: ✓(ポンと出る)+文言。loading より done が優先", () => {
    const out = html({ done: true, loading: true }, "保存する");
    expect(out).toContain("animate-pm-pop");
    expect(out).toContain("motion-reduce:animate-none");
    expect(out).toContain("完了しました");
    expect(out).not.toContain("animate-spin");
  });

  it("通常時は invisible の重ねを出さない(余計な要素を増やさない)", () => {
    const out = html({}, "保存する");
    expect(out).not.toContain("invisible");
    expect(out).toContain(">保存する</button>");
  });

  it("★呼び出し側の disabled は loading=false でも外れない", () => {
    const out = html({ disabled: true, loading: false }, "保存する");
    expect(out).toMatch(/<button[^>]*disabled=""/);
    expect(out).not.toContain("aria-busy");
  });
});
