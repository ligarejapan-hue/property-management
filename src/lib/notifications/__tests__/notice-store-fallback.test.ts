/**
 * 保存できない環境(容量超過・保存の制限)でも、この画面の間はベルに出す(@codex #462)。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  addNotice,
  clearNoticeStorage,
  loadNotices,
  readNoticeSnapshot,
  saveNotices,
  withNoticeLock,
  type Notice,
} from "../notice-store";

const notice: Notice = { id: "a", kind: "edit_lock_lost", tag: "t", message: "m", at: 1, read: false };

function stubWindow(storage: Partial<Storage>) {
  (globalThis as { window?: unknown }).window = {
    localStorage: storage,
    dispatchEvent: () => true,
  };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("保存できないとき", () => {
  it("書き込みが失敗しても、この画面の間は控えを返す", () => {
    stubWindow({
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
      removeItem: () => {},
    });
    saveNotices([notice]);
    expect(readNoticeSnapshot()).toEqual([notice]);
    expect(loadNotices(2)).toEqual([notice]);
    // 後片付けで控えも消す(共用 PC)。
    clearNoticeStorage();
    expect(readNoticeSnapshot()).toEqual([]);
  });

  it("書き込めたら控えは使わない", () => {
    const stored = new Map<string, string>();
    stubWindow({
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => {
        stored.set(k, v);
      },
      removeItem: (k: string) => {
        stored.delete(k);
      },
    });
    saveNotices([notice]);
    expect(loadNotices(2).map((n) => n.id)).toEqual(["a"]);
  });
});

describe("後片付けと重なった書き戻し(@codex #462 P1)", () => {
  it("後片付けの後に前の合図で書かれたお知らせは読まない", () => {
    const stored = new Map<string, string>();
    stubWindow({
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => {
        stored.set(k, v);
      },
      removeItem: (k: string) => {
        stored.delete(k);
      },
    });
    stored.set("pm:notices:switched-at", "100");
    // 前の人のタブが合図 "100" を確かめた直後に、ほかのタブが後片付けをした。
    clearNoticeStorage();
    // そのあと前の人のタブが書き込む(合図の確認と書き込みの間に割り込まれた)。
    saveNotices([{ ...notice, at: Date.now(), mark: "100" }]);
    expect(stored.get("pm:notices:v1")).toBeTruthy();
    expect(readNoticeSnapshot()).toEqual([]);
    expect(loadNotices(2)).toEqual([]);
  });

  it("今の合図で書いたものは出す", () => {
    const stored = new Map<string, string>([["pm:notices:switched-at", "200"]]);
    stubWindow({
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => {
        stored.set(k, v);
      },
      removeItem: (k: string) => {
        stored.delete(k);
      },
    });
    const at = Date.now();
    saveNotices([{ ...notice, id: "b", at, mark: "200" }, { ...notice, id: "c", tag: "u", at, mark: "100" }]);
    expect(readNoticeSnapshot().map((n) => n.id)).toEqual(["b"]);
    expect(loadNotices(at).map((n) => n.id)).toEqual(["b"]);
  });
});

describe("ほかのタブと同時に足したとき(@codex #462)", () => {
  afterEach(() => {
    delete (globalThis as { navigator?: unknown }).navigator;
  });

  it("Web Locks があれば読み→足す→書くを1件ずつ順に行う(先の追加を上書きしない)", async () => {
    const stored = new Map<string, string>();
    stubWindow({
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => {
        stored.set(k, v);
      },
      removeItem: (k: string) => {
        stored.delete(k);
      },
    });
    // 1本の列で順に処理する Web Locks の代わり。
    let chain: Promise<unknown> = Promise.resolve();
    const names: string[] = [];
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        locks: {
          request: (name: string, cb: () => Promise<unknown>) => {
            names.push(name);
            const p = chain.then(cb);
            chain = p.catch(() => {});
            return p;
          },
        },
      },
    });
    const at = Date.now();
    withNoticeLock(() => saveNotices(addNotice(loadNotices(at), { ...notice, id: "x", tag: "x", at }, at)));
    withNoticeLock(() => saveNotices(addNotice(loadNotices(at), { ...notice, id: "y", tag: "y", at }, at)));
    await chain;
    expect(names).toEqual(["pm:notices", "pm:notices"]);
    expect(loadNotices(at).map((n) => n.id).sort()).toEqual(["x", "y"]);
  });

  it("Web Locks が無ければその場で行う", () => {
    let ran = false;
    withNoticeLock(() => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
