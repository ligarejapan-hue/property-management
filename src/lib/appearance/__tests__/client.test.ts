import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  APPEARANCE_CHANGE_EVENT,
  applyDensity,
  applyLayout,
  readDensity,
  readLayout,
  saveAppearance,
  subscribeAppearance,
} from "../client";

// 小さな偽の document / window / localStorage で、画面側の付け替えを実際に動かす。
let attrs: Map<string, string>;
let store: Map<string, string>;
let blocked: boolean;
let target: EventTarget;

beforeEach(() => {
  attrs = new Map();
  store = new Map();
  blocked = false;
  target = new EventTarget();
  vi.stubGlobal("document", {
    documentElement: {
      setAttribute: (k: string, v: string) => attrs.set(k, v),
      getAttribute: (k: string) => attrs.get(k) ?? null,
    },
  });
  vi.stubGlobal("window", {
    localStorage: {
      setItem: (k: string, v: string) => {
        if (blocked) throw new Error("blocked");
        store.set(k, v);
      },
    },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("文字サイズ・レイアウトの付け替え", () => {
  it("html に付け、端末に覚え、表示中の選択欄すべてに知らせる", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeAppearance(a);
    subscribeAppearance(b);
    applyDensity("large");
    expect(attrs.get("data-density")).toBe("large");
    expect(store.get("pm-density")).toBe("large");
    expect(readDensity()).toBe("large");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    offA();
    applyLayout("top");
    expect(readLayout()).toBe("top");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });
  it("端末に覚えられなくても画面には付ける(落ちない)", () => {
    blocked = true;
    expect(() => applyDensity("compact")).not.toThrow();
    expect(readDensity()).toBe("compact");
  });
  it("知らない値・未設定は 標準・左サイドバー として読む", () => {
    attrs.set("data-density", "huge");
    expect(readDensity()).toBe("normal");
    expect(readLayout()).toBe("side");
  });
  it("合図の名前は1つ", () => {
    expect(APPEARANCE_CHANGE_EVENT).toBe("pm-appearance-change");
  });
});

describe("saveAppearance", () => {
  it("PATCH /api/me/preferences に送り、成否を返す(通信の失敗でも落ちない)", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await saveAppearance({ theme: "navy" })).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/me/preferences", expect.objectContaining({ method: "PATCH", body: '{"theme":"navy"}' }));
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await saveAppearance({ density: "large" })).toBe(false);
  });
});
