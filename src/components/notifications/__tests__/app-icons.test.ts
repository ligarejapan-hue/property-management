/**
 * ホーム画面のアイコンと通知の絵(2026-10-07・自社ロゴ「J」にそろえる)。
 *
 * - manifest(Android のホーム画面)・apple-touch-icon(iPhone のホーム画面)の画像が、書いた大きさのとおりの PNG であること。
 * - Service Worker が出す通知は、どれも同じ絵(NOTIFY_ICON)を付けること(付け忘れるとブラウザ任せの絵になる)。
 * - 通知の絵は `/icons/` の下(ログイン前にも読める=src/proxy.ts で認証を免除)にあること。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import manifest from "@/app/manifest";

const ROOT = resolve(__dirname, "../../../..");
const SW = readFileSync(resolve(ROOT, "public/sw.js"), "utf-8");

/** PNG の幅と高さ(IHDR)。PNG でなければ null。 */
function pngSize(path: string): { w: number; h: number } | null {
  const b = readFileSync(resolve(ROOT, "public", path.replace(/^\//, "")));
  if (b.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

describe("ホーム画面のアイコン", () => {
  it("manifest の各アイコンは、書いた大きさの PNG", () => {
    const icons = manifest().icons ?? [];
    expect(icons.length).toBeGreaterThan(0);
    for (const icon of icons) {
      const [w, h] = String(icon.sizes).split("x").map(Number);
      expect(pngSize(icon.src), icon.src).toEqual({ w, h });
    }
  });

  it("iPhone 用(apple-touch-icon)は 180×180 の PNG", () => {
    const layout = readFileSync(resolve(ROOT, "src/app/layout.tsx"), "utf-8");
    expect(layout).toContain('apple: "/icons/apple-touch-icon.png"');
    expect(pngSize("/icons/apple-touch-icon.png")).toEqual({ w: 180, h: 180 });
  });
});

describe("通知の絵", () => {
  it("NOTIFY_ICON は /icons/ の下の実在する PNG", () => {
    const m = /const NOTIFY_ICON = "([^"]+)";/.exec(SW);
    expect(m).not.toBeNull();
    const icon = m![1];
    expect(icon.startsWith("/icons/")).toBe(true);
    expect(pngSize(icon)).not.toBeNull();
  });

  it("showNotification のすべての呼び出しが icon: NOTIFY_ICON を付ける", () => {
    const calls = SW.split("showNotification(").slice(1);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      // 呼び出しの options(次の "});" まで)に絵の指定がある
      const opts = c.slice(0, c.indexOf("})"));
      expect(opts).toContain("icon: NOTIFY_ICON");
    }
  });
});
