/**
 * 物件の編集ウィンドウに配線した編集中の鍵(Task 5)を node で検証する。
 *
 * ⚠このリポジトリは jsdom を使わない方針(vitest.config.ts が environment: "node" を
 *   固定・既存の .test.tsx は renderToStaticMarkup 一本槍)。フォームを描画して
 *   クリックするテストは書けないので、保存の init 組み立て(buildPropertySaveInit)と
 *   開いたときの初期化順序(initEditLockOnOpen)を関数として切り出して node で検査し、
 *   配線そのものは走査(source assertion)で固定する
 *   (`src/hooks/__tests__/use-address-lookup.test.ts` と同じやり方)。
 *
 * ⚠「帯が出る」「保存ボタンが押せない」の判断自体は Task 2 の純関数(ui-state.ts)と
 *   Task 4 の部品(EditLockBanner)で既に検査済み。ここでは重複して検査しない(YAGNI)。
 *   画面が本当に繋がっているかはローカル実機確認で見る。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { buildPropertySaveInit, initEditLockOnOpen } from "../property-edit-form";
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
  it("4) useEditLock・ensureUniqueScreenToken・EditLockBanner・disabled= を含む(配線のラチェット)", () => {
    expect(src).toContain("useEditLock(");
    expect(src).toContain("ensureUniqueScreenToken(");
    expect(src).toContain("EditLockBanner");
    expect(src).toContain("disabled={");
  });

  it("保存のヘッダはbuildPropertySaveInit経由(手組みしない)", () => {
    expect(src).toContain("buildPropertySaveInit(");
  });

  it("保存の失敗はapiErrorCodeで読み、noteSaveErrorへ渡す(コードの写像はTask2に任せる)", () => {
    expect(src).toContain("apiErrorCode(");
    expect(src).toContain("noteSaveError(");
  });

  it("入力・キー・ポインタでnoteActivityを呼ぶ(期限切れの取り直しの引き金)", () => {
    expect(src).toContain("noteActivity()");
  });

  it("複製タブ検知(300ms)が終わるまで保存ボタンをdisabledにする(tokenReadyを条件に含む)", () => {
    expect(src).toMatch(/disabled=\{[^}]*tokenReady/);
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
