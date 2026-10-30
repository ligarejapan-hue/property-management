import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { appearanceBootScript } from "../boot-script";

// 画面を描く前に走るスクリプトを、小さな偽の document / localStorage で実際に動かして確かめる。
type Store = Map<string, string>;
let store: Store;
let attrs: Map<string, string>;
let broken = false;

function run(src: string) {
  const localStorage = {
    getItem: (k: string) => {
      if (broken) throw new Error("blocked");
      return store.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (broken) throw new Error("blocked");
      store.set(k, v);
    },
  };
  const document = { documentElement: { setAttribute: (k: string, v: string) => attrs.set(k, v) } };
  new Function("window", "document", src)({ localStorage }, document);
}

beforeEach(() => {
  store = new Map();
  attrs = new Map();
  broken = false;
});

describe("appearanceBootScript", () => {
  it("ログイン中: DB の値で端末のキャッシュを上書きし、文字サイズ・レイアウトを html に付ける", () => {
    store.set("theme", "dark");
    store.set("pm-density", "compact");
    run(appearanceBootScript({ theme: "navy", density: "large", layout: "top" }));
    expect(store.get("theme")).toBe("navy");
    expect(store.get("pm-density")).toBe("large");
    expect(attrs.get("data-density")).toBe("large");
    expect(attrs.get("data-layout")).toBe("top");
  });

  it("自動=system・スタンダード=light で覚える(next-themes の値)", () => {
    run(appearanceBootScript({ theme: "auto", density: "normal", layout: "side" }));
    expect(store.get("theme")).toBe("system");
    run(appearanceBootScript({ theme: "standard", density: "normal", layout: "side" }));
    expect(store.get("theme")).toBe("light");
  });

  it("ログインしていない: 端末に覚えた値を使う・知らない値は付けない", () => {
    store.set("pm-density", "compact");
    store.set("pm-layout", "weird");
    run(appearanceBootScript(null));
    expect(attrs.get("data-density")).toBe("compact");
    expect(attrs.has("data-layout")).toBe(false);
  });

  it("localStorage が使えない環境でも例外を出さない", () => {
    broken = true;
    expect(() => run(appearanceBootScript({ theme: "washi", density: "large", layout: "side" }))).not.toThrow();
  });

  it("端末に保存できなくても、ログイン中は DB の文字サイズ・レイアウトを付ける(@codex #618)", () => {
    broken = true;
    run(appearanceBootScript({ theme: "washi", density: "large", layout: "top" }));
    expect(attrs.get("data-density")).toBe("large");
    expect(attrs.get("data-layout")).toBe("top");
  });

  it("ログイン中は端末に残った古い値ではなく DB の値を使う", () => {
    store.set("pm-density", "compact");
    run(appearanceBootScript({ theme: "auto", density: "normal", layout: "side" }));
    expect(attrs.get("data-density")).toBe("normal");
  });

  it("ログイン中の色は next-themes の初期値にも DB の値を渡す(端末に保存できなくても DB の色)", () => {
    const layout = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "app", "layout.tsx"), "utf8");
    expect(layout).toContain('defaultTheme={appearance ? toNextTheme(appearance.theme) : "system"}');
  });

  it("埋め込みに < を含めない(script を閉じられない)", () => {
    expect(appearanceBootScript({ theme: "washi", density: "large", layout: "side" })).not.toContain("<");
  });
});
