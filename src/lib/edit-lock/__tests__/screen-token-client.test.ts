import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, join, relative, dirname } from "node:path";
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
   * 外部レビュー(@codex)P1・round1(2026-09-26)。
   *
   * 横断レビュー M1 で応答器(`answerScreenTokenProbes`)を「鍵を使っている間だけ」に
   * 絞った結果、**編集していないタブから応答器そのものが消えた**。すると:
   * 空いている物件詳細のタブを複製しても、元のタブが誰も答えないので複製タブは
   * 写し取った合言葉を使い続け、あとで両方のタブが所有者を編集し始めても
   * `held_by_self_other_screen` にならず**同じ画面**として扱われる
   * (D6「自分の別の窓も待つ」が黙って成り立たなくなる)。
   *
   * 裁定(round1): **画面につき1本・画面の寿命ぶん**張る。M1 の本当の不満は「本数」で
   * あって「存在」ではなかった(所有者120人で120本開くのが問題だった)。画面(親)で
   * 1本だけ張れば、本数は1本になり、かつ編集前のタブでも複製を検出できる。
   *
   * round2(同日): round1 はこの一生を `properties/[id]/page.tsx` だけに書いた。
   * しかし `CorporateLookupPanel`(`applyOwnerCorporate` 経由で鍵のヘッダ=合言葉を
   * 送る)は `admin/owners/[id]/page.tsx` からも描かれるのに、その画面は応答器も
   * 一意化も持っていなかった。物件詳細タブを複製→片方が鍵を取る→管理画面の複製
   * タブが写し取ったままの合言葉で反映を送ると、サーバは「合言葉が保持者と同じ=
   * 同じ画面」と分類して鍵をすり抜けさせてしまう([[fix-all-call-sites-not-one]]の型)。
   *
   * Ruling(round2): 一生は「物件詳細の画面」のものではなく、**鍵のヘッダを送る
   * すべての画面**のもの。`useEditScreenToken()` hook に括り出し、この検査は
   * **手書きの一覧をやめて導出する**——鍵のヘッダを送る画面の集合を実際の
   * import 関係から機械的に求め、hook を呼んでいる `page.tsx` の集合と一致する
   * ことを assert する。新しい画面が鍵のヘッダを送るようになったのに hook を
   * 呼び忘れると、この検査は名前を挙げて落ちる(=手書きの一覧に追記し忘れるという
   * 3回目の型を防ぐ)。
   *
   * ⚠この検査は**配線**を固定する(モジュール単体の振る舞いは上の
   *   `answerScreenTokenProbes` の describe が既に固定している。P1 は
   *   「どこに張るか」だけの穴だったので、単体テストでは捕まえられない)。
   */
  describe("鍵のヘッダを送る画面はすべて useEditScreenToken() を呼ぶ(外部レビューP1 round2・導出型ラチェット)", () => {
    const HOOK = "src/hooks/use-edit-screen-token.ts";
    const API_CLIENT = "src/lib/api-client.ts";
    const EXCLUDE_DIRS = new Set(["__tests__", "generated", "node_modules"]);
    /** 「鍵のヘッダを送る画面(site)」の候補から除くファイル(自分自身)。 */
    const EXCLUDE_SITE_FILES = new Set<string>([API_CLIENT, HOOK]);
    /** 鍵の一次実装が集まる場所そのものは、候補から丸ごと除く(仕様どおり)。 */
    const EXCLUDE_SITE_DIR_PREFIX = "src/lib/edit-lock/";

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
    const allSourceFiles = () => listSourceFiles(join(process.cwd(), "src"));

    const read = (rel: string) =>
      readFileSync(resolve(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

    /** `openIndex` の `{` に対応する `}` の位置(波かっこの対応数え)。 */
    function matchingBraceEnd(src: string, openIndex: number): number {
      let depth = 0;
      for (let i = openIndex; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") {
          depth--;
          if (depth === 0) return i;
        }
      }
      return src.length - 1;
    }

    /** `openIndex` の `(` に対応する `)` の位置(引数リストの対応数え)。 */
    function matchingParenEnd(src: string, openIndex: number): number {
      let depth = 0;
      for (let i = openIndex; i < src.length; i++) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")") {
          depth--;
          if (depth === 0) return i;
        }
      }
      return -1;
    }

    /**
     * 1. `api-client.ts` を読み、**本文(関数本体)**に `editLockHeaders(` または
     *    `getScreenToken(` を含む `export (async )?function` の名前を集める
     *    (= 鍵のヘッダを運ぶ api 関数。手書きしない)。
     *
     * ⚠関数名の直後の最初の `{` を本体の開始と決め打ちしない: 引数の型注釈
     *   (`opts: { lockId?: string | null } = {}` 等)にも `{` が出るため、まず
     *   引数リストの `(...)` を対応数えで飛び越してから、その後ろの最初の `{` を
     *   本体の開始とする。
     */
    function lockHeaderFunctionNames(): string[] {
      const src = read(API_CLIENT);
      const names: string[] = [];
      const fnRe = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = fnRe.exec(src))) {
        const parenStart = src.indexOf("(", m.index);
        if (parenStart === -1) continue;
        const parenEnd = matchingParenEnd(src, parenStart);
        if (parenEnd === -1) continue;
        const braceStart = src.indexOf("{", parenEnd);
        if (braceStart === -1) continue;
        const braceEnd = matchingBraceEnd(src, braceStart);
        const body = src.slice(braceStart, braceEnd + 1);
        if (/editLockHeaders\(|getScreenToken\(/.test(body)) {
          names.push(m[1]);
        }
      }
      return names;
    }

    function escapeRegExp(s: string): string {
      return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    /**
     * 2. `src/` 配下(`__tests__`・`src/lib/edit-lock/**`・`src/lib/api-client.ts`・
     *    `src/hooks/use-edit-screen-token.ts` を除く)で、(1)の名前を import して
     *    いるファイル、または `editLockHeaders` を import しているファイルを
     *    「鍵のヘッダを送るモジュール」とする。
     *
     * ⚠**import 文**で数える(呼び出しの文字列やコメントの中の言及ではなく)。
     */
    function lockHeaderSendingModules(): string[] {
      const names = lockHeaderFunctionNames();
      const namesPattern = names.map(escapeRegExp).join("|");
      const importsNameRe = namesPattern
        ? new RegExp(
            `import\\s*(?:type\\s*)?\\{[^}]*\\b(?:${namesPattern})\\b[^}]*\\}\\s*from`,
          )
        : null;
      const importsEditLockHeadersRe =
        /import\s*(?:type\s*)?\{[^}]*\beditLockHeaders\b[^}]*\}\s*from/;

      const sites: string[] = [];
      for (const file of allSourceFiles()) {
        const rel = relative(process.cwd(), file).replace(/\\/g, "/");
        if (EXCLUDE_SITE_FILES.has(rel)) continue;
        if (rel.startsWith(EXCLUDE_SITE_DIR_PREFIX)) continue;
        const content = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
        if (
          (importsNameRe && importsNameRe.test(content)) ||
          importsEditLockHeadersRe.test(content)
        ) {
          sites.push(rel);
        }
      }
      return sites;
    }

    /** `@/…` は `src/…` に、相対 import はそのファイルからの相対に解決する。 */
    function resolveImportPath(fromFileAbs: string, specifier: string): string | null {
      if (!specifier.startsWith("@/") && !specifier.startsWith(".")) return null; // 外部パッケージは無視
      const base = specifier.startsWith("@/")
        ? join(process.cwd(), "src", specifier.slice(2))
        : join(dirname(fromFileAbs), specifier);
      const candidates = [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        join(base, "index.ts"),
        join(base, "index.tsx"),
      ];
      for (const c of candidates) {
        try {
          if (existsSync(c) && statSync(c).isFile()) return c;
        } catch {
          /* 到達不能なパスは無視 */
        }
      }
      return null;
    }

    function importedSpecifiers(fileAbs: string): string[] {
      const content = readFileSync(fileAbs, "utf8").replace(/\r\n/g, "\n");
      const specs: string[] = [];
      const re = /from\s*["']([^"']+)["']/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content))) specs.push(m[1]);
      return specs;
    }

    function allPageFiles(): string[] {
      return allSourceFiles()
        .map((f) => relative(process.cwd(), f).replace(/\\/g, "/"))
        .filter((rel) => /^src\/app\/.*\/page\.tsx$/.test(rel));
    }

    /**
     * 3. `@/…` の import を `src/…(.ts|.tsx|/index.ts(x))` に解決して推移閉包を取り、
     *    `src/app/**\/page.tsx` のうち(2)に到達するものを「鍵を使う画面」とする。
     */
    function pagesReachingLockHeaderSites(): string[] {
      const siteSet = new Set(lockHeaderSendingModules());
      const reaching: string[] = [];
      for (const pageRel of allPageFiles()) {
        const pageAbs = join(process.cwd(), pageRel);
        const visited = new Set<string>();
        const stack = [pageAbs];
        let hit = false;
        while (stack.length > 0) {
          const cur = stack.pop()!;
          const curRel = relative(process.cwd(), cur).replace(/\\/g, "/");
          if (visited.has(curRel)) continue;
          visited.add(curRel);
          if (siteSet.has(curRel)) {
            hit = true;
            break;
          }
          for (const spec of importedSpecifiers(cur)) {
            const resolved = resolveImportPath(cur, spec);
            if (resolved) stack.push(resolved);
          }
        }
        if (hit) reaching.push(pageRel);
      }
      return reaching.sort();
    }

    /** 4. `useEditScreenToken` を import している `page.tsx` の集合。 */
    function pagesCallingHook(): string[] {
      const importsHookRe =
        /import\s*\{[^}]*\buseEditScreenToken\b[^}]*\}\s*from\s*["']@\/hooks\/use-edit-screen-token["']/;
      return allPageFiles()
        .filter((rel) => importsHookRe.test(read(rel)))
        .sort();
    }

    it("鍵のヘッダを送る画面(api-client/editLockHeadersから機械的に導出)の集合と、useEditScreenToken()を呼ぶpage.tsxの集合が一致する", () => {
      const derived = pagesReachingLockHeaderSites();
      const wired = pagesCallingHook();
      expect(
        wired,
        "新しく鍵のヘッダを送る画面を作ったら useEditScreenToken() を呼ぶこと。" +
          `導出された画面=${JSON.stringify(derived)} / hookを呼んでいる画面=${JSON.stringify(wired)}`,
      ).toEqual(derived);
    });

    it("導出は空振りではない(少なくとも1画面を検出する=検査が常に緑にしかならない状態ではない)", () => {
      expect(pagesReachingLockHeaderSites().length).toBeGreaterThan(0);
    });

    /**
     * 5. 応答器そのものの設置箇所は、hook のファイル1つだけであること
     *    (page も component も `use-edit-lock` hook も張らない)。
     */
    function responderInstallSites(): string[] {
      const IMPORTS_RESPONDER =
        /import\s*\{[^}]*\banswerScreenTokenProbes\b[^}]*\}\s*from\s*["']@\/lib\/edit-lock\/screen-token-client["']/;
      const sites: string[] = [];
      for (const file of allSourceFiles()) {
        const rel = relative(process.cwd(), file).replace(/\\/g, "/");
        if (rel === "src/lib/edit-lock/screen-token-client.ts") continue;
        if (IMPORTS_RESPONDER.test(readFileSync(file, "utf8").replace(/\r\n/g, "\n"))) {
          sites.push(rel);
        }
      }
      return sites.sort();
    }

    it("応答器の import 元は use-edit-screen-token.ts の1つだけ(page・component・use-edit-lockも張らない)", () => {
      expect(
        responderInstallSites(),
        "応答器は『画面につき1本・画面の寿命ぶん』を hook 1本に集約した。page・component・" +
          "他の hook が直接張ると文書あたりの本数が増える(round1の逆戻り)。",
      ).toEqual([HOOK]);
    });

    it("hookのuseEffectは1行の暗黙returnであること(波かっこ版に戻すとP1が再発する)", () => {
      // ⚠`if (editing)` 等の条件を挟んだ瞬間、空きタブが複製に気づけなくなる(P1)。
      expect(read(HOOK)).toMatch(/useEffect\(\(\) => answerScreenTokenProbes\(\), \[\]\)/);
    });

    it("波かっこ版(停止関数を捨てる書き方)ではない", () => {
      // ⚠`useEffect(() => { answerScreenTokenProbes(); }, [])` は停止関数を捨て、
      //   画面を離れてもチャンネルが開いたまま残る。
      expect(read(HOOK)).not.toMatch(/useEffect\(\(\) => \{\s*answerScreenTokenProbes\(\);/);
    });
  });
});
