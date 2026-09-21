import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getScreenToken,
  ensureUniqueScreenToken,
  resetScreenTokenForTest,
  editLockHeaders,
  answerScreenTokenProbes,
  setScreenTokenEnvForTest,
  SCREEN_TOKEN_PROBE_MS,
  type ScreenTokenEnv,
  type ScreenTokenChannel,
} from "../screen-token-client";
import { EDIT_SCREEN_HEADER, EDIT_LOCK_HEADER } from "../header-names";

/**
 * このリポジトリは jsdom を使わない方針(既存の .test.tsx は
 * renderToStaticMarkup 一本槍)。sessionStorage/BroadcastChannel は
 * ScreenTokenEnv を介してフェイクに差し替え、node のまま検証する。
 */

/** 同じ名前で `openChannel` した相手どうしにだけメッセージを届ける、フェイクの配線盤。 */
function createChannelHub() {
  const rooms = new Map<string, Map<symbol, (data: unknown) => void>>();
  function openChannel(name: string): ScreenTokenChannel {
    const id = Symbol("channel-endpoint");
    let room = rooms.get(name);
    if (!room) {
      room = new Map();
      rooms.set(name, room);
    }
    const thisRoom = room;
    return {
      postMessage(data: unknown) {
        for (const [otherId, handler] of thisRoom.entries()) {
          // 本物の BroadcastChannel と同じく、送った本人には届かない。
          if (otherId !== id) handler(data);
        }
      },
      onMessage(handler: (data: unknown) => void) {
        thisRoom.set(id, handler);
      },
      close() {
        thisRoom.delete(id);
      },
    };
  }
  return { openChannel };
}

function createFakeEnv(overrides: Partial<ScreenTokenEnv> = {}): {
  env: ScreenTokenEnv;
  storage: Map<string, string>;
  hub: ReturnType<typeof createChannelHub>;
} {
  const storage = new Map<string, string>();
  const hub = createChannelHub();
  let idCounter = 0;
  const env: ScreenTokenEnv = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => {
      storage.set(key, value);
    },
    openChannel: (name) => hub.openChannel(name),
    newId: () => `fake-token-${++idCounter}`,
    ...overrides,
  };
  return { env, storage, hub };
}

describe("画面の合言葉(client)", () => {
  beforeEach(() => {
    resetScreenTokenForTest();
    vi.useFakeTimers();
  });

  afterEach(() => {
    setScreenTokenEnvForTest(null);
    vi.useRealTimers();
  });

  it("初回は採番して保存し、2回目は同じ値を返す", () => {
    const { env, storage } = createFakeEnv();
    setScreenTokenEnvForTest(env);

    const a = getScreenToken();
    expect(a).toBe("fake-token-1");
    expect(storage.get("edit-screen-token")).toBe(a);
    expect(getScreenToken()).toBe(a);
  });

  it("保存が使えなくてもその画面の間は同じ値を返す(例外にしない)", () => {
    const throwingEnv: ScreenTokenEnv = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      openChannel: () => null,
      newId: () => "fake-token-blocked",
    };
    setScreenTokenEnvForTest(throwingEnv);

    expect(() => getScreenToken()).not.toThrow();
    const a = getScreenToken();
    expect(a).toBe("fake-token-blocked");
    expect(getScreenToken()).toBe(a);
  });

  it("同じ合言葉を名乗る生きたタブが居たら、複製と判断して作り直す", async () => {
    const { env, storage, hub } = createFakeEnv();
    storage.set("edit-screen-token", "duplicated-token");
    setScreenTokenEnvForTest(env);

    // 生きたタブの代役: 問い合わせに同じ合言葉で即答する
    const other = hub.openChannel("edit-screen");
    other.onMessage((data) => {
      const msg = data as { type: string; token: string };
      if (msg.type === "who-has") other.postMessage({ type: "i-have", token: msg.token });
    });

    const token = await ensureUniqueScreenToken();
    other.close();

    expect(token).not.toBe("duplicated-token");
    expect(storage.get("edit-screen-token")).toBe(token);
  });

  it("返事が無ければ同じ合言葉を使い続ける(同タブの再読み込み=D6)", async () => {
    const { env, storage } = createFakeEnv();
    storage.set("edit-screen-token", "reload-token");
    setScreenTokenEnvForTest(env);

    const promise = ensureUniqueScreenToken();
    await vi.advanceTimersByTimeAsync(SCREEN_TOKEN_PROBE_MS);
    const token = await promise;

    expect(token).toBe("reload-token");
    expect(storage.get("edit-screen-token")).toBe("reload-token");
  });

  it("openChannel が null を返す環境でも例外にせず、そのまま使う", async () => {
    const { env, storage } = createFakeEnv({ openChannel: () => null });
    storage.set("edit-screen-token", "no-channel-token");
    setScreenTokenEnvForTest(env);

    const token = await ensureUniqueScreenToken();
    expect(token).toBe("no-channel-token");
  });

  it("300msの窓を過ぎてから届いた返事は、複製と数えない", async () => {
    const { env, storage, hub } = createFakeEnv();
    storage.set("edit-screen-token", "late-answer-token");
    setScreenTokenEnvForTest(env);

    const other = hub.openChannel("edit-screen");
    other.onMessage((data) => {
      const msg = data as { type: string; token: string };
      if (msg.type === "who-has") {
        // 窓(300ms)を過ぎてから答える。
        setTimeout(() => other.postMessage({ type: "i-have", token: msg.token }), SCREEN_TOKEN_PROBE_MS + 1);
      }
    });

    const promise = ensureUniqueScreenToken();
    await vi.advanceTimersByTimeAsync(SCREEN_TOKEN_PROBE_MS + 1);
    const token = await promise;
    other.close();

    expect(token).toBe("late-answer-token");
    expect(storage.get("edit-screen-token")).toBe("late-answer-token");
  });

  describe("editLockHeaders", () => {
    it("常に X-Edit-Screen を現在の合言葉で付ける", () => {
      const { env } = createFakeEnv();
      setScreenTokenEnvForTest(env);
      const token = getScreenToken();

      const headers = editLockHeaders();
      expect(headers[EDIT_SCREEN_HEADER]).toBe(token);
    });

    it("lockId を渡したときだけ X-Edit-Lock を付ける", () => {
      const { env } = createFakeEnv();
      setScreenTokenEnvForTest(env);
      const lockId = "44444444-4444-4444-4444-444444444444";

      const headers = editLockHeaders(lockId);
      expect(headers[EDIT_LOCK_HEADER]).toBe(lockId);
    });

    it("null/undefined の lockId では X-Edit-Lock キー自体を作らない", () => {
      const { env } = createFakeEnv();
      setScreenTokenEnvForTest(env);

      expect(Object.prototype.hasOwnProperty.call(editLockHeaders(null), EDIT_LOCK_HEADER)).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(editLockHeaders(undefined), EDIT_LOCK_HEADER)).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(editLockHeaders(), EDIT_LOCK_HEADER)).toBe(false);
    });
  });

  describe("answerScreenTokenProbes", () => {
    it("有効な間、自分の合言葉への問い合わせには答える", () => {
      const { env, hub } = createFakeEnv();
      setScreenTokenEnvForTest(env);
      const token = getScreenToken();

      const stop = answerScreenTokenProbes();
      const asker = hub.openChannel("edit-screen");
      let answer: { type?: string; token?: string } | null = null;
      asker.onMessage((data) => {
        answer = data as { type?: string; token?: string };
      });

      asker.postMessage({ type: "who-has", token });

      expect(answer).toEqual({ type: "i-have", token });
      asker.close();
      stop();
    });

    it("違う合言葉への問い合わせには答えない", () => {
      const { env, hub } = createFakeEnv();
      setScreenTokenEnvForTest(env);
      getScreenToken();

      const stop = answerScreenTokenProbes();
      const asker = hub.openChannel("edit-screen");
      let answered = false;
      asker.onMessage(() => {
        answered = true;
      });

      asker.postMessage({ type: "who-has", token: "someone-elses-token" });

      expect(answered).toBe(false);
      asker.close();
      stop();
    });

    it("返した停止関数を呼ぶと、以後は問い合わせに答えなくなる", () => {
      const { env, hub } = createFakeEnv();
      setScreenTokenEnvForTest(env);
      const token = getScreenToken();

      const stop = answerScreenTokenProbes();
      stop();

      const asker = hub.openChannel("edit-screen");
      let answered = false;
      asker.onMessage(() => {
        answered = true;
      });

      asker.postMessage({ type: "who-has", token });

      expect(answered).toBe(false);
      asker.close();
    });
  });
});
