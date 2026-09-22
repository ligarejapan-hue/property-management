/**
 * 物件の編集ウィンドウに配線した編集中の鍵(Task 5)を node で検証する。
 *
 * ⚠このリポジトリは jsdom を使わない方針(vitest.config.ts が environment: "node" を
 *   固定・既存の .test.tsx は renderToStaticMarkup 一本槍)。フォームを描画して
 *   クリックするテストは書けないので、保存の init 組み立て(buildPropertySaveInit)・
 *   開いたときの初期化とfail openの後始末(runEditLockInit)・保存ボタンを押せるかの
 *   判断(canSubmitSave)・fail open通知を出してよいか(shouldShowLockUnavailableNotice)
 *   を関数として切り出して node で検査し、配線そのものは走査(source assertion)で
 *   固定する(`src/hooks/__tests__/use-address-lookup.test.ts` と同じやり方)。
 *
 * ⚠「帯が出る」の判断自体は Task 2 の純関数(ui-state.ts)と Task 4 の部品
 *   (EditLockBanner)で既に検査済み。ここでは重複して検査しない(YAGNI)。
 *   画面が本当に繋がっているかはローカル実機確認で見る。
 *
 * task5 review round1 の反映:
 * - Critical: 取得(acquire)が失敗しても保存を詰まらせない(fail open)。
 *   `runEditLockInit` を追加し、成否どちらでも例外を投げず `lockUnavailable` を
 *   更新することを検査する。
 * - Important: 走査だけの配線ラチェットが自己満足(helperの定義自体で満たされる/
 *   `disabled={` が本タスク以前から3箇所あり判断が実行されているかを固定できない)
 *   だった穴を、コンポーネント本体に絞った検査(`useEffect` の中で `runEditLockInit(`
 *   を呼ぶこと)と `canSubmitSave` の直接検査に差し替える。
 *
 * task5 review round2 の反映:
 * - N1(Important): 複製タブ確認(`ensureUniqueScreenToken`)自体が失敗しても
 *   `onReady` を呼ぶ(fail open)ことを検査(旧・内部専用関数の直接テストは廃止し、
 *   `runEditLockInit` 経由で検査=N4)。
 * - N3: fail openの通知は `lock.state.kind === "idle"` の間だけ出す
 *   (`shouldShowLockUnavailableNotice` として切り出して検査)。
 * - N4: 例外を投げる内部専用関数(旧 `initEditLockOnOpen`)は export しない。
 *   `runEditLockInit` だけを画面からの唯一の入口として検査する。
 * - N5: 配線の走査を書式(改行・空白)依存から、実際の引数(本物の
 *   `ensureUniqueScreenToken`・本物の `lock.acquire()`)の検査へ差し替える。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  buildPropertySaveInit,
  runEditLockInit,
  canSubmitSave,
  shouldShowLockUnavailableNotice,
} from "../property-edit-form";
import { EDIT_SCREEN_HEADER, EDIT_LOCK_HEADER } from "@/lib/edit-lock/header-names";
import {
  setScreenTokenEnvForTest,
  resetScreenTokenForTest,
  type ScreenTokenEnv,
} from "@/lib/edit-lock/screen-token-client";

const src = readFileSync(
  resolve(process.cwd(), "src/components/properties/property-edit-form.tsx"),
  "utf8",
);
/**
 * ⚠(review round1 Important) コンポーネント本体だけを見る。ヘルパー関数
 *   (内部専用の初期化・`runEditLockInit`・`canSubmitSave`・
 *   `shouldShowLockUnavailableNotice` の定義)はこのマーカーより前にあるため、
 *   ここから先だけを検査すれば「定義自体が自分の呼び出しを満たしてしまう」
 *   自己満足なテストにならない。
 */
const COMPONENT_MARKER = "export default function PropertyEditForm";
const componentSrc = src.slice(src.indexOf(COMPONENT_MARKER));

/** `getScreenToken()` が固定の合言葉を返すだけの、最小限のフェイク env。 */
function fakeScreenTokenEnv(token: string): ScreenTokenEnv {
  return {
    getItem: () => token,
    setItem: () => {},
    openChannel: () => null,
    newId: () => token,
  };
}

describe("buildPropertySaveInit(保存のfetch initを作る)", () => {
  beforeEach(() => {
    resetScreenTokenForTest();
    setScreenTokenEnvForTest(fakeScreenTokenEnv("screen-1"));
  });
  afterEach(() => {
    setScreenTokenEnvForTest(null);
    resetScreenTokenForTest();
  });

  it("1) lockId が無いときは X-Edit-Screen だけを載せ、X-Edit-Lock は載せない", () => {
    const init = buildPropertySaveInit({}, null);
    const headers = init.headers as Record<string, string>;
    expect(headers[EDIT_SCREEN_HEADER]).toBe("screen-1");
    expect(EDIT_LOCK_HEADER in headers).toBe(false);
  });

  it("2) lockId があるときは X-Edit-Lock にその値を載せる", () => {
    const init = buildPropertySaveInit({}, "l1");
    const headers = init.headers as Record<string, string>;
    expect(headers[EDIT_LOCK_HEADER]).toBe("l1");
    expect(headers[EDIT_SCREEN_HEADER]).toBe("screen-1");
  });

  it("3) method=PATCH・Content-Type=application/json・bodyは従来どおり", () => {
    const payload = { version: 3, note: "x" };
    const init = buildPropertySaveInit(payload, null);
    expect(init.method).toBe("PATCH");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify(payload));
  });
});

describe("PropertyEditForm の配線(source assertion)", () => {
  it("4) useEditLock・ensureUniqueScreenToken・EditLockBanner を含む(配線のラチェット)", () => {
    expect(src).toContain("useEditLock(");
    expect(src).toContain("ensureUniqueScreenToken(");
    expect(src).toContain("EditLockBanner");
  });

  it("保存のヘッダはbuildPropertySaveInit経由(手組みしない)", () => {
    expect(src).toContain("buildPropertySaveInit(");
  });

  it("保存の失敗はcodeFromErrorBodyで読んだコードをapiErrorCode経由でnoteSaveErrorへ渡す(写像はTask2に任せる)", () => {
    expect(src).toContain("codeFromErrorBody(");
    expect(src).toContain("apiErrorCode(");
    expect(src).toContain("noteSaveError(");
  });

  it("入力・キー・ポインタでnoteActivityを呼ぶ(期限切れの取り直しの引き金)", () => {
    expect(src).toContain("noteActivity()");
  });

  it("旧・内部専用の初期化関数はexportしない(review round2 N4・後続画面が安全でない入口を写さないため)", () => {
    expect(src).not.toContain("export async function initEditLockOnOpen");
    expect(src).not.toContain("export function initEditLockOnOpen");
  });

  it("5) コンポーネント本体がuseEffectの中でrunEditLockInitを、本物の引数で呼ぶ(review round1 Important + round2 N5)", () => {
    // ⚠(review round2 N5) 書式(改行・字下げ)に依存する正規表現は、リフォーマット
    //   だけで空振りするため`\s+`で許容する。一方、引数は本物であることを固定する:
    //   1本目が本物の`ensureUniqueScreenToken`(スタブに差し替えられていない)、
    //   呼び出しの中に`lock.acquire()`が含まれる(`() => Promise.resolve()`のような
    //   「何も取得しない」形に差し替えても検査が空振りしない)。
    const match = componentSrc.match(
      /useEffect\(\s*\(\)\s*=>\s*\{\s*let alive = true;\s*void runEditLockInit\(([\s\S]*?)\);\s*return \(\)\s*=>\s*\{\s*alive = false;\s*\};/,
    );
    expect(match).not.toBeNull();
    const args = match![1];
    // 1本目の引数(合言葉の確認)は本物の関数参照そのもの。
    expect(args).toMatch(/^\s*ensureUniqueScreenToken,/);
    // 3本目の引数(取得)は実際にlock.acquire()を呼ぶ。
    expect(args).toContain("lock.acquire()");
  });

  it("保存ボタンのdisabledはcanSubmitSaveの戻り値をそのまま使う(コンポーネント本体で呼ぶ)", () => {
    // ⚠`disabled={` は本タスク以前から複数箇所にあり(review round1 Important)、
    //   存在チェックだけでは判断が実行されているか固定できない。`canSubmitSave(`
    //   という具体的な呼び出しをコンポーネント本体側で要求する。
    expect(componentSrc).toMatch(/disabled=\{\s*!canSubmitSave\(/);
  });

  it("複製タブ検知(300ms)が終わるまで保存ボタンをdisabledにする(tokenReadyをcanSubmitSaveへ渡す)", () => {
    expect(componentSrc).toMatch(/canSubmitSave\(\{\s*tokenReady/);
  });

  it("fail openの通知はshouldShowLockUnavailableNotice経由(idle以外では出さない・review round2 N3)", () => {
    expect(componentSrc).toMatch(/shouldShowLockUnavailableNotice\(\s*lockUnavailable/);
  });
});

describe("runEditLockInit(開いたときの初期化・fail openの後始末・review round1 Critical/round2 N1)", () => {
  it("6) ensureUniqueScreenTokenが解決するまでacquireを呼ばない。解決後にonReady→acquireの順で1回だけ呼ぶ", async () => {
    const calls: string[] = [];
    let resolveToken!: (value: string) => void;
    const ensureUniqueScreenToken = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveToken = resolve;
        }),
    );
    const onReady = vi.fn(() => calls.push("ready"));
    const acquire = vi.fn(async () => {
      calls.push("acquire");
    });
    const setLockUnavailable = vi.fn();

    const pending = runEditLockInit(ensureUniqueScreenToken, onReady, acquire, setLockUnavailable);

    // マイクロタスクを何度掃いても、まだトークン確認が解決していない間は何も起きない。
    await Promise.resolve();
    await Promise.resolve();
    expect(acquire).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
    expect(calls).toEqual([]);

    resolveToken("t1");
    await pending;

    expect(acquire).toHaveBeenCalledTimes(1);
    // ⚠順序も固定する: tokenReadyを立ててからacquireを呼ぶ(帯を出す/出さないの前提)。
    expect(calls).toEqual(["ready", "acquire"]);
    expect(setLockUnavailable).toHaveBeenCalledWith(false);
  });

  it("7) ensureUniqueScreenToken自体が失敗しても例外を投げず、onReadyは呼ぶ(fail open・review round2 N1)", async () => {
    const setLockUnavailable = vi.fn();
    const onReady = vi.fn();
    const acquire = vi.fn(async () => {});

    // ⚠ここでawaitがrejectしたら、この関数はfail openの契約を破っている
    //   (呼び出し側`void runEditLockInit(...)`がunhandled rejectionを残す)。
    await expect(
      runEditLockInit(
        () => Promise.reject(new Error("BROADCAST_CHANNEL_FAILED")),
        onReady,
        acquire,
        setLockUnavailable,
      ),
    ).resolves.toBeUndefined();

    // ⚠複製タブ確認そのものが失敗しても、保存ボタンの「確認待ち」だけは解除する
    //   (screen-token-client.tsがBroadcastChannel不在時に取っているfail openの
    //   姿勢と揃える)。これが無いと、canSubmitSaveはtokenReady=falseのままなので
    //   lockUnavailable=trueでも保存ボタンが永久に押せない=通知の文言と自己矛盾する。
    expect(onReady).toHaveBeenCalledTimes(1);
    // 合言葉すら確認できていないので、取得(acquire)は試みない。
    expect(acquire).not.toHaveBeenCalled();
    expect(setLockUnavailable).toHaveBeenCalledTimes(1);
    expect(setLockUnavailable).toHaveBeenCalledWith(true);
  });

  it("8) acquireが失敗しても例外を投げず、lockUnavailableをtrueにする(fail open)", async () => {
    const setLockUnavailable = vi.fn();
    const onReady = vi.fn();

    await expect(
      runEditLockInit(
        () => Promise.resolve("t1"),
        onReady,
        () => Promise.reject(new Error("EDIT_LOCK_ACQUIRE_FAILED")),
        setLockUnavailable,
      ),
    ).resolves.toBeUndefined();

    expect(setLockUnavailable).toHaveBeenCalledTimes(1);
    expect(setLockUnavailable).toHaveBeenCalledWith(true);
    // ⚠複製タブ検知は取得より前に終わっているので、取得が失敗してもtokenReadyは立つ
    //   (保存ボタン自体は複製タブ検知だけで解禁され、その先の可否はcanSubmitSaveが握る)。
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("9) acquireが成功すればlockUnavailableをfalseにする(通知が消える側)", async () => {
    const setLockUnavailable = vi.fn();

    await runEditLockInit(
      () => Promise.resolve("t1"),
      () => {},
      () => Promise.resolve(),
      setLockUnavailable,
    );

    expect(setLockUnavailable).toHaveBeenCalledTimes(1);
    expect(setLockUnavailable).toHaveBeenCalledWith(false);
  });
});

describe("canSubmitSave(保存ボタンを押せるかの判断)", () => {
  it("tokenReadyがfalseならcanSave/lockUnavailableに関わらず押せない", () => {
    expect(
      canSubmitSave({ tokenReady: false, canSave: true, saving: false, lockUnavailable: true }),
    ).toBe(false);
  });

  it("saving中は押せない", () => {
    expect(
      canSubmitSave({ tokenReady: true, canSave: true, saving: true, lockUnavailable: false }),
    ).toBe(false);
  });

  it("鍵を持っていれば押せる(通常経路)", () => {
    expect(
      canSubmitSave({ tokenReady: true, canSave: true, saving: false, lockUnavailable: false }),
    ).toBe(true);
  });

  it("鍵を持っておらず取得も失敗していなければ押せない(他人が持っている等)", () => {
    expect(
      canSubmitSave({ tokenReady: true, canSave: false, saving: false, lockUnavailable: false }),
    ).toBe(false);
  });

  it("鍵は持っていないが取得自体が失敗していればfail openで押せる(review round1 Critical)", () => {
    expect(
      canSubmitSave({ tokenReady: true, canSave: false, saving: false, lockUnavailable: true }),
    ).toBe(true);
  });

  it("鍵を持っていて、かつlockUnavailableがtrueでも押せる(矛盾しない組み合わせ)", () => {
    expect(
      canSubmitSave({ tokenReady: true, canSave: true, saving: false, lockUnavailable: true }),
    ).toBe(true);
  });
});

describe("shouldShowLockUnavailableNotice(fail open通知と実際の鍵の帯を矛盾させない・review round2 N3)", () => {
  it("lockUnavailableかつidleなら出す", () => {
    expect(shouldShowLockUnavailableNotice(true, "idle")).toBe(true);
  });

  it("lockUnavailableがfalseなら(状態に関わらず)出さない", () => {
    expect(shouldShowLockUnavailableNotice(false, "idle")).toBe(false);
  });

  it("lockUnavailableでも、状態がtakenへ動いたら出さない(実際の鍵の帯と矛盾させない)", () => {
    expect(shouldShowLockUnavailableNotice(true, "taken")).toBe(false);
  });

  it("lockUnavailableでも、状態がexpiredへ動いたら出さない", () => {
    expect(shouldShowLockUnavailableNotice(true, "expired")).toBe(false);
  });

  it("lockUnavailableでも、状態がmineへ動いたら出さない(取得できた=通常の帯に任せる)", () => {
    expect(shouldShowLockUnavailableNotice(true, "mine")).toBe(false);
  });
});
