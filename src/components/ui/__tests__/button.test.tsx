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
});
