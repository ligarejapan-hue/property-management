import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join, relative } from "node:path";
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

  /**
   * 外部レビュー(@codex)P1・2026-09-26。
   *
   * 横断レビュー M1 で応答器(`answerScreenTokenProbes`)を「鍵を使っている間だけ」に
   * 絞った結果、**編集していないタブから応答器そのものが消えた**。すると:
   * 空いている物件詳細のタブを複製しても、元のタブが誰も答えないので複製タブは
   * 写し取った合言葉を使い続け、あとで両方のタブが所有者を編集し始めても
   * `held_by_self_other_screen` にならず**同じ画面**として扱われる
   * (D6「自分の別の窓も待つ」が黙って成り立たなくなる)。
   *
   * 裁定: **画面につき1本・画面の寿命ぶん**張る。M1 の本当の不満は「本数」であって
   * 「存在」ではなかった(所有者120人で120本開くのが問題だった)。画面(親)で1本
   * だけ張れば、本数は1本になり、かつ編集前のタブでも複製を検出できる。
   *
   * ⚠この検査は**配線**を固定する(モジュール単体の振る舞いは上の
   *   `answerScreenTokenProbes` の describe が既に固定している。P1 は
   *   「どこに張るか」だけの穴だったので、単体テストでは捕まえられない)。
   */
  describe("応答器の設置箇所(外部レビューP1・画面につき1本・画面の寿命ぶん)", () => {
    /** この画面(物件詳細)だけが応答器を張る。 */
    const PAGE = "src/app/(dashboard)/properties/[id]/page.tsx";
    /** 応答器を定義しているモジュール自身(コメント・定義がヒットするので除く)。 */
    const MODULE = "src/lib/edit-lock/screen-token-client.ts";
    const EXCLUDE_DIRS = new Set(["__tests__", "generated", "node_modules"]);

    function listSourceFiles(dir: string): string[] {
      const files: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (EXCLUDE_DIRS.has(entry.name)) continue;
          files.push(...listSourceFiles(full));
        } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
          files.push(full);
        }
      }
      return files;
    }

    const read = (rel: string) =>
      readFileSync(resolve(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

    /**
     * ⚠**import 文**で数える(呼び出しの文字列ではなく)。コメントの中で名前に触れている
     *   だけのファイル(「応答器は画面側で張る」という申し送りなど)を設置箇所と
     *   数えないため。
     */
    const IMPORTS_RESPONDER =
      /import\s*\{[^}]*\banswerScreenTokenProbes\b[^}]*\}\s*from\s*["']@\/lib\/edit-lock\/screen-token-client["']/;

    function responderInstallSites(): string[] {
      const sites: string[] = [];
      for (const file of listSourceFiles(join(process.cwd(), "src"))) {
        const rel = relative(process.cwd(), file).replace(/\\/g, "/");
        if (rel === MODULE) continue;
        if (IMPORTS_RESPONDER.test(readFileSync(file, "utf8").replace(/\r\n/g, "\n"))) {
          sites.push(rel);
        }
      }
      return sites.sort();
    }

    it("設置箇所は物件詳細画面の1つだけ=文書につき1本(所有者カードが何枚あっても増えない)", () => {
      const sites = responderInstallSites();
      expect(
        sites,
        "応答器は『画面につき1本・画面の寿命ぶん』。新しく鍵を使う画面を作るときは、" +
          "その画面(親)で1本だけ張り、この一覧に追記すること。部品・カード・hook 側で" +
          "張ると文書あたりの本数が増え、編集中だけに絞ると複製タブを検出できなくなる(P1)。",
      ).toEqual([PAGE]);
    });

    it("編集していない(idle)画面でも答える=編集中かどうかで絞らない(P1の再発防止)", () => {
      // ⚠`useEffect(() => answerScreenTokenProbes(), [])` の1行であること。
      //   `if (editing)` や `if (!controller) return;` のような条件が入った時点で、
      //   複製した空きタブが自分を複製と気づけなくなる(=P1そのもの)。
      expect(read(PAGE)).toMatch(/useEffect\(\(\) => answerScreenTokenProbes\(\), \[\]\)/);
    });

    it("unmount で片付ける(戻り値の停止関数をそのまま cleanup として返している)", () => {
      // ⚠`useEffect(() => { answerScreenTokenProbes(); }, [])` と書くと停止関数を
      //   捨ててしまい、画面を離れてもチャンネルが開いたまま残る。波括弧なしの
      //   暗黙の return であることを固定する。
      const pageSrc = read(PAGE);
      expect(pageSrc).toMatch(/useEffect\(\(\) => answerScreenTokenProbes\(\), \[\]\)/);
      expect(pageSrc).not.toMatch(/useEffect\(\(\) => \{\s*answerScreenTokenProbes\(\);/);
    });

    it("鍵の hook は応答器を張らない(カードごと・編集中だけの設置に戻さない)", () => {
      expect(responderInstallSites()).not.toContain("src/hooks/use-edit-lock.ts");
    });

    it("編集ウィンドウも自分では張らない(同じ文書に2本目を作らない)", () => {
      // ⚠この部品は物件詳細画面の中にしか描かれない(=画面側の1本で足りる)。
      expect(responderInstallSites()).not.toContain(
        "src/components/properties/property-edit-form.tsx",
      );
    });
  });
});
