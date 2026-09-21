// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getScreenToken,
  ensureUniqueScreenToken,
  resetScreenTokenForTest,
  editLockHeaders,
  answerScreenTokenProbes,
} from "../screen-token-client";
import { EDIT_SCREEN_HEADER, EDIT_LOCK_HEADER } from "../header-names";

describe("画面の合言葉(client)", () => {
  beforeEach(() => {
    resetScreenTokenForTest();
    try {
      sessionStorage.clear();
    } catch {
      /* 使えない環境は無視 */
    }
  });

  it("初回は採番して sessionStorage に保存し、2回目は同じ値を返す", () => {
    const a = getScreenToken();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(sessionStorage.getItem("edit-screen-token")).toBe(a);
    expect(getScreenToken()).toBe(a);
  });

  it("sessionStorage が使えなくてもその画面の間は同じ値を返す(例外にしない)", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const a = getScreenToken();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(getScreenToken()).toBe(a);
    spy.mockRestore();
  });

  it("同じ合言葉を名乗る生きたタブが居たら、複製と判断して作り直す", async () => {
    sessionStorage.setItem("edit-screen-token", "11111111-1111-4111-8111-111111111111");
    // 生きたタブの代役: 問い合わせに同じ合言葉で即答する BroadcastChannel
    const other = new BroadcastChannel("edit-screen");
    other.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type: string; token: string };
      if (msg.type === "who-has") other.postMessage({ type: "i-have", token: msg.token });
    };
    const token = await ensureUniqueScreenToken();
    other.close();
    expect(token).not.toBe("11111111-1111-4111-8111-111111111111");
    expect(sessionStorage.getItem("edit-screen-token")).toBe(token);
  });

  it("返事が無ければ同じ合言葉を使い続ける(同タブの再読み込み=D6)", async () => {
    sessionStorage.setItem("edit-screen-token", "22222222-2222-4222-8222-222222222222");
    const token = await ensureUniqueScreenToken();
    expect(token).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("BroadcastChannel が無い環境でも例外にせず、そのまま使う", async () => {
    sessionStorage.setItem("edit-screen-token", "33333333-3333-4333-8333-333333333333");
    const saved = globalThis.BroadcastChannel;
    // @ts-expect-error 環境の再現
    delete globalThis.BroadcastChannel;
    const token = await ensureUniqueScreenToken();
    globalThis.BroadcastChannel = saved;
    expect(token).toBe("33333333-3333-4333-8333-333333333333");
  });

  describe("editLockHeaders", () => {
    it("常に X-Edit-Screen を現在の合言葉で付ける", () => {
      const token = getScreenToken();
      const headers = editLockHeaders();
      expect(headers[EDIT_SCREEN_HEADER]).toBe(token);
    });

    it("lockId を渡したときだけ X-Edit-Lock を付ける", () => {
      const lockId = "44444444-4444-4444-4444-444444444444";
      const headers = editLockHeaders(lockId);
      expect(headers[EDIT_LOCK_HEADER]).toBe(lockId);
    });

    it("null/undefined の lockId では X-Edit-Lock キー自体を作らない", () => {
      expect(Object.prototype.hasOwnProperty.call(editLockHeaders(null), EDIT_LOCK_HEADER)).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(editLockHeaders(undefined), EDIT_LOCK_HEADER)).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(editLockHeaders(), EDIT_LOCK_HEADER)).toBe(false);
    });
  });

  describe("answerScreenTokenProbes", () => {
    it("有効な間、自分の合言葉への問い合わせには答える", async () => {
      const token = getScreenToken();
      const stop = answerScreenTokenProbes();
      const asker = new BroadcastChannel("edit-screen");
      const answered = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 300);
        asker.onmessage = (e: MessageEvent) => {
          const msg = e.data as { type?: string; token?: string };
          if (msg.type === "i-have" && msg.token === token) {
            clearTimeout(timer);
            resolve(true);
          }
        };
      });
      asker.postMessage({ type: "who-has", token });
      expect(await answered).toBe(true);
      asker.close();
      stop();
    });

    it("違う合言葉への問い合わせには答えない", async () => {
      getScreenToken();
      const stop = answerScreenTokenProbes();
      const asker = new BroadcastChannel("edit-screen");
      const answered = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 300);
        asker.onmessage = () => {
          clearTimeout(timer);
          resolve(true);
        };
      });
      asker.postMessage({ type: "who-has", token: "99999999-9999-4999-8999-999999999999" });
      expect(await answered).toBe(false);
      asker.close();
      stop();
    });

    it("返した停止関数を呼ぶと、以後は問い合わせに答えなくなる", async () => {
      const token = getScreenToken();
      const stop = answerScreenTokenProbes();
      stop();
      const asker = new BroadcastChannel("edit-screen");
      const answered = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 300);
        asker.onmessage = () => {
          clearTimeout(timer);
          resolve(true);
        };
      });
      asker.postMessage({ type: "who-has", token });
      expect(await answered).toBe(false);
      asker.close();
    });
  });
});
