import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// @codex #618 P2: ログイン画面から画面を切り替えて入ったとき(再読み込みなし)も、その人の設定を反映する。
const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "appearance-sync.tsx"), "utf8");
const dashboardLayout = readFileSync(join(dir, "..", "..", "..", "app", "(dashboard)", "layout.tsx"), "utf8");
const rootLayout = readFileSync(join(dir, "..", "..", "..", "app", "layout.tsx"), "utf8");

describe("AppearanceSync", () => {
  it("ルートの layout は「この人の設定で描いた」印を html に付ける", () => {
    expect(rootLayout).toContain("data-appearance-user={loaded?.userId}");
  });
  it("印がログイン中の人と同じなら何もしない(再読み込みで描いた画面=二重に読まない)", () => {
    expect(src).toMatch(/if \(html\.getAttribute\(APPEARANCE_USER_ATTR\) === userId\) return;/);
  });
  it("違えば設定を読み直して 色・文字サイズ・レイアウト を反映し、印を付け替える", () => {
    expect(src).toContain('fetch("/api/me/preferences", { cache: "no-store" })');
    expect(src).toContain("setTheme(toNextTheme(eff.theme))");
    expect(src).toContain("applyDensity(eff.density)");
    expect(src).toContain("applyLayout(eff.layout)");
    expect(src).toContain("html.setAttribute(APPEARANCE_USER_ATTR, userId)");
  });
  it("ログイン後の画面(枠)に置いてある", () => {
    expect(dashboardLayout).toContain("<AppearanceSync />");
  });
});
