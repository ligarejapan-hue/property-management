/**
 * 保存できない環境(容量超過・保存の制限)でも、この画面の間はベルに出す(@codex #462)。
 */
import { afterEach, describe, expect, it } from "vitest";
import { clearNoticeStorage, loadNotices, readNoticeSnapshot, saveNotices, type Notice } from "../notice-store";

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
    let stored: string | null = null;
    stubWindow({
      getItem: () => stored,
      setItem: (_k: string, v: string) => {
        stored = v;
      },
      removeItem: () => {
        stored = null;
      },
    });
    saveNotices([notice]);
    expect(loadNotices(2).map((n) => n.id)).toEqual(["a"]);
  });
});
