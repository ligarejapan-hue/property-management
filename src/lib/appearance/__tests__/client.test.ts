import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  APPEARANCE_CHANGE_EVENT,
  applyDensity,
  applyLayout,
  readDensity,
  readLayout,
  saveAppearance,
  subscribeAppearance,
  loadPreferences,
  savePreferences,
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
    const fetchMock = vi.fn(async () => Response.json({ data: { effective: {} } }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await saveAppearance({ theme: "navy" })).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/me/preferences", expect.objectContaining({ method: "PATCH", body: '{"theme":"navy"}' }));
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await saveAppearance({ density: "large" })).toBe(false);
  });
});

// 段階4: 設定 > 表示・利用者メニュー・スマホのメニューで、個人・会社の標準・選べる色を1回の読み込みで共有する。
describe("loadPreferences / savePreferences", () => {
  const data = (theme: string) => ({
    user: { theme, density: null, layout: null }, company: {}, allowedThemes: ["auto", "navy"],
    effective: { theme, density: "normal", layout: "side" }, canEditCompany: false,
  });
  it("1回だけ読み、続けて呼んでも同じ結果を使う(force で読み直す)", async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: data("navy") }));
    vi.stubGlobal("fetch", fetchMock);
    const a = await loadPreferences(true);
    const b = await loadPreferences();
    expect(a?.allowedThemes).toEqual(["auto", "navy"]);
    expect(b).toBe(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const heard = vi.fn();
    target.addEventListener("pm-preferences-saved", (e) => heard((e as CustomEvent).detail));
    await loadPreferences(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 読み直したときも合図を出す(管理者が選べる色を変えた直後にスマホのメニューが追随する)
    expect(heard).toHaveBeenCalledTimes(1);
  });
  it("読めなかったら null・次はもう一度読みにいく", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    expect(await loadPreferences(true)).toBeNull();
    const ok = vi.fn(async () => Response.json({ data: data("auto") }));
    vi.stubGlobal("fetch", ok);
    expect((await loadPreferences())?.effective.theme).toBe("auto");
    expect(ok).toHaveBeenCalledTimes(1);
  });
  it("開いたときの読み込みが保存より遅れて届いても、古い中身で上書きしない(@codex #623)", async () => {
    let releaseGet: (r: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn((_u: string, init?: RequestInit) =>
      init?.method === "PATCH"
        ? Promise.resolve(Response.json({ data: data("navy") }))
        : new Promise<Response>((r) => { releaseGet = r; })));
    const heard = vi.fn();
    target.addEventListener("pm-preferences-saved", (e) => heard((e as CustomEvent).detail.user.theme));
    const load = loadPreferences(true);
    const saved = await savePreferences({ theme: "navy" });
    releaseGet(Response.json({ data: data("") }));
    expect(await load).toBe(saved);
    expect(heard.mock.calls).toEqual([["navy"]]);
    expect(await loadPreferences()).toBe(saved);
  });
  it("保存の返事が逆の順に届いても、先に始めた方で上書きしない", async () => {
    const releases: ((r: Response) => void)[] = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => releases.push(r))));
    const first = savePreferences({ theme: "washi" });
    const second = savePreferences({ theme: "navy" });
    releases[1](Response.json({ data: data("navy") }));
    await second;
    releases[0](Response.json({ data: data("washi") }));
    expect((await first)?.user.theme).toBe("washi");
    expect((await loadPreferences())?.user.theme).toBe("navy");
  });
  it("保存できたら、その結果を読み込み済みの値にする(失敗は null)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: data("navy") })));
    const heard = vi.fn();
    target.addEventListener("pm-preferences-saved", (e) => heard((e as CustomEvent).detail));
    const saved = await savePreferences({ theme: "navy" });
    expect(saved?.user.theme).toBe("navy");
    // 別の場所(利用者メニュー)での保存を 設定 > 表示 が受け取れる
    expect(heard).toHaveBeenCalledWith(saved);
    const again = vi.fn();
    vi.stubGlobal("fetch", again);
    expect(await loadPreferences()).toBe(saved);
    expect(again).not.toHaveBeenCalled();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 422 })));
    expect(await savePreferences({ theme: "washi" })).toBeNull();
  });
});
