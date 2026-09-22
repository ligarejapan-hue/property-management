/**
 * 物件の編集ウィンドウに配線した編集中の鍵(Task 5)を node で検証する。
 *
 * ⚠このリポジトリは jsdom を使わない方針(vitest.config.ts が environment: "node" を
 *   固定・既存の .test.tsx は renderToStaticMarkup 一本槍)。フォームを描画して
 *   クリックするテストは書けないので、保存の init 組み立て(buildPropertySaveInit)・
 *   開いたときの初期化順序(initEditLockOnOpen)・fail openの後始末(runEditLockInit)・
 *   保存ボタンを押せるかの判断(canSubmitSave)を関数として切り出して node で検査し、
 *   配線そのものは走査(source assertion)で固定する
 *   (`src/hooks/__tests__/use-address-lookup.test.ts` と同じやり方)。
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
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  buildPropertySaveInit,
  initEditLockOnOpen,
  runEditLockInit,
  canSubmitSave,
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
 *   (`initEditLockOnOpen`・`runEditLockInit`・`canSubmitSave` の定義)はこの
 *   マーカーより前にあるため、ここから先だけを検査すれば「定義自体が自分の
 *   呼び出しを満たしてしまう」自己満足なテストにならない。
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

  it("5') コンポーネント本体がuseEffectの中でrunEditLockInitを呼ぶ(効果ごと削除したら落ちる・review round1 Important)", () => {
    // ⚠ヘルパーの定義(`export async function runEditLockInit(`)はマーカーより前にあり、
    //   このアサーションには影響しない。useEffect全体を削除する/呼び出しだけを
    //   抜くと、このテストが落ちる(従来は`ensureUniqueScreenToken(`の存在だけを
    //   見ており、ヘルパー自身の本体がそれを満たしてしまい何も保証していなかった)。
    expect(componentSrc).toMatch(/useEffect\(\(\) => \{\s*let alive = true;\s*void runEditLockInit\(/);
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
});

describe("initEditLockOnOpen(開いたときの初期化順序)", () => {
  it("5) ensureUniqueScreenTokenが解決するまでacquireを呼ばない。解決後に1回だけ呼ぶ", async () => {
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

    const pending = initEditLockOnOpen(ensureUniqueScreenToken, onReady, acquire);

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
  });
});

describe("runEditLockInit(取得の成否に応じてlockUnavailableを更新する・review round1 Critical)", () => {
  it("6) acquireが失敗しても例外を投げず、lockUnavailableをtrueにする(fail open)", async () => {
    const setLockUnavailable = vi.fn();
    const onReady = vi.fn();

    // ⚠ここでawaitがrejectしたら、この関数はfail openの契約を破っている
    //   (呼び出し側`void runEditLockInit(...)`がunhandled rejectionを残す)。
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

  it("7) acquireが成功すればlockUnavailableをfalseにする(通知が消える側)", async () => {
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
