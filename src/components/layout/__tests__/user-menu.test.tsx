import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "navy", setTheme: () => {} }) }));
import UserMenu, { ThemeDot, DISPLAY_SETTINGS_HREF } from "../user-menu";

// 見た目の設定 段階4(2026-10-31): ヘッダーの利用者メニュー(色テーマだけすぐ切り替える)。
const src = readFileSync(join(process.cwd(), "src/components/layout/user-menu.tsx"), "utf8").replace(/\r\n/g, "\n");

describe("利用者メニュー", () => {
  it("最初は閉じたボタン(名前は md 以上・読み上げ用の名前あり)", () => {
    const html = renderToStaticMarkup(<UserMenu userName="山田 太郎" currentPath="/home" />);
    expect(html).toMatch(/<button[^>]*aria-expanded="false"/);
    expect(html).toContain('aria-label="山田 太郎のメニュー(色テーマ・表示の設定)"');
    expect(html).toContain("hidden max-w-[10rem] truncate md:inline");
    expect(html).not.toContain('id="user-menu-panel"');
  });
  it("色はラジオで選び、すぐ反映して保存する(選べる色は会社の設定にそろえる)", () => {
    expect(src).toContain('type="radio"');
    expect(src).toMatch(/setTheme\(toNextTheme\(o\.value\)\);\s*void saveAppearance\(\{ theme: o\.value \}\)/);
    expect(src).toContain("allowed.includes(o.value)");
  });
  it("文字サイズ・配置は 設定 > 表示 へのリンク", () => {
    expect(DISPLAY_SETTINGS_HREF).toBe("/settings/display");
    expect(src).toContain("href={DISPLAY_SETTINGS_HREF}");
  });
  it("外を押す・Esc(ボタンへ戻る)・画面の移動で閉じる", () => {
    expect(src).toContain('document.addEventListener("pointerdown", onPointer)');
    expect(src).toMatch(/e\.key !== "Escape"[\s\S]*buttonRef\.current\?\.focus\(\)/);
    expect(src).toMatch(/if \(prevPath !== currentPath\) \{\s*setPrevPath\(currentPath\);\s*setOpen\(false\);/);
  });
  it("スマホの幅では画面の両端に合わせて出す(ボタンの右端にそろえると左へはみ出した)", () => {
    expect(src).toContain("fixed left-3 right-3 top-14");
    expect(src).toContain("sm:absolute sm:left-auto sm:right-0 sm:top-full sm:w-64");
  });
  it("スマホの幅ではパスワード変更もここから(ヘッダーの鍵の絵は sm 以上だけ=題名の幅を残す)", () => {
    expect(src).toContain('href="/admin/change-password"');
    const header = readFileSync(join(process.cwd(), "src/components/layout/header.tsx"), "utf8");
    expect(header).toMatch(/href="\/admin\/change-password"\s*className="hidden sm:flex/);
  });
  it("矢印は動きを減らす設定では回さない", () => {
    expect(src).toContain("motion-reduce:transition-none");
  });
  it("色の見本の点は そのテーマの色", () => {
    expect(renderToStaticMarkup(<ThemeDot theme="forest" />)).toContain("linear-gradient");
  });
});
