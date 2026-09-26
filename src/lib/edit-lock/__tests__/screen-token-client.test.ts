import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
    setScreenTokenEnvForTest(null);
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
    // ⚠newId は呼ぶたびに違う値を返す(review Important 1)。固定文字列だと
    //   メモ化(memoryToken)が無くても2回目がたまたま一致してしまい、
    //   「その画面の間は同じ値を返す」を検査できていなかった。
    let idCounter = 0;
    const throwingEnv: ScreenTokenEnv = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      openChannel: () => null,
      newId: () => `fake-token-blocked-${++idCounter}`,
    };
    setScreenTokenEnvForTest(throwingEnv);

    expect(() => getScreenToken()).not.toThrow();
    const a = getScreenToken();
    expect(a).toBe("fake-token-blocked-1");
    expect(getScreenToken()).toBe(a);
  });

  it("同じ合言葉を名乗る生きたタブが居たら、複製と判断して作り直す", async () => {
    const { env, storage, hub } = createFakeEnv();
    storage.set("edit-screen-token", "duplicated-token");
    setScreenTokenEnvForTest(env);

    // 生きたタブの代役: 問い合わせに同じ合言葉で即答する。
    // ⚠(branch review round2 N1) 本物の answerScreenTokenProbes() は必ず
    //   自分の文書ID(docId)を答えに載せる(Task6 fix round1)。docId を省いた
    //   答えは実際のプロトコルの形を再現できておらず、「docId が無ければ複製と
    //   数える」という誤った条件(`&& !msg.docId`)に書き換えられても、この
    //   テストは通り続けてしまう。別の文書(=本物の複製タブ)であることを、
    //   自分のDOCUMENT_IDとは異なる文字列で明示する。
    const other = hub.openChannel("edit-screen");
    other.onMessage((data) => {
      const msg = data as { type: string; token: string };
      if (msg.type === "who-has") {
        other.postMessage({ type: "i-have", token: msg.token, docId: "other-document" });
      }
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

  it("(branch review・Task6 fix round1) 同じ文書(document)からの返事は複製と数えない(自分のカードの答えを自分の複製と誤認しない)", async () => {
    // ⚠answerScreenTokenProbes() と ensureUniqueScreenToken() は同じモジュール
    //   インスタンス(=同じ「文書」)から呼ぶ。所有者カードがそれぞれ
    //   answerScreenTokenProbes() を張ったまま、物件の編集ウィンドウが
    //   ensureUniqueScreenToken() を呼ぶ状況を1つの env(=1つのタブ)の中で再現する。
    const { env, storage } = createFakeEnv();
    storage.set("edit-screen-token", "same-doc-token");
    setScreenTokenEnvForTest(env);

    const stopAnswering = answerScreenTokenProbes();
    // ⚠自分の文書からの返事は無視されるので、複製の判定は(誰も答えなかったときと
    //   同じく)300msの窓を待ち切って初めて確定する。
    const promise = ensureUniqueScreenToken();
    await vi.advanceTimersByTimeAsync(SCREEN_TOKEN_PROBE_MS);
    const token = await promise;
    stopAnswering();

    expect(token).toBe("same-doc-token");
    expect(storage.get("edit-screen-token")).toBe("same-doc-token");
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
      let answer: { type?: string; token?: string; docId?: string } | null = null;
      asker.onMessage((data) => {
        answer = data as { type?: string; token?: string; docId?: string };
      });

      asker.postMessage({ type: "who-has", token });

      // ⚠(branch review round2 N3) 答えには自分の文書ID(docId)も載る。値そのものは
      //   (モジュール読み込み時の乱数のため)固定できないので expect.any(String) で
      //   受けるが、`toEqual` の完全一致は保つ=想定外の余分なフィールドが
      //   紛れ込んでもこのテストが検知できるようにする(型だけの検査に緩めない)。
      expect(answer).toEqual({ type: "i-have", token, docId: expect.any(String) });
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

  /**
   * 横断レビュー M2。このモジュールは repo で唯一の `src/lib` 配下の `"use client"`
   * モジュールで、4,500行の共有 `api-client.ts` が **値として** import している
   * (`editLockHeaders`/`getScreenToken`)。将来 route handler が api-client から
   * 何か1つ引いた瞬間に「Attempted to call … from the server」になる潜在の穴。
   * このファイルは JSX も hook も持たず、ブラウザAPIは全部 `ScreenTokenEnv`+try/catch
   * の向こう(`DOCUMENT_ID` の `crypto.randomUUID()` は Node/Edge でも動く)なので、
   * ディレクティブは不要。
   */
  describe("client/server の境界(横断レビュー M2)", () => {
    const moduleSrc = () =>
      readFileSync(
        resolve(process.cwd(), "src/lib/edit-lock/screen-token-client.ts"),
        "utf8",
      ).replace(/\r\n/g, "\n");

    it('"use client" を持たない(共有 api-client.ts が client 専用モジュールへ値依存しない)', () => {
      expect(moduleSrc()).not.toMatch(/^\s*["']use client["']/m);
    });

    it("react も component も import しない(純粋なモジュールであること)", () => {
      expect(moduleSrc()).not.toMatch(/from ["']react["']/);
      expect(moduleSrc()).not.toMatch(/from ["']@\/components\//);
    });
  });
});
