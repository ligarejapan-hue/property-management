/**
 * 所有者カードに配線した編集中の鍵(仕様 6.2・Task 6)を node で検証する。
 *
 * ⚠このリポジトリは jsdom を使わない方針(vitest.config.ts が environment: "node" を
 *   固定)。カードを描画してクリックするテストは書けないので、
 *   - `updateOwner` のヘッダ組み立て(第3引数 opts.lockId)
 *   - 取得の fail open(`runOwnerLockAcquire`)
 *   の2つは実際に関数を呼んで node で検証し、
 *   - 配線そのもの(useEditLock・EditLockBanner・updateOwner呼び出し)
 *   - 所有者ごとの独立性(resourceId=po.ownerId・enabled=このカードのediting)
 *   - 複製タブ確認は画面につき1回だけ(カードごとに増えない)
 *   は走査(source assertion)で固定する(`property-edit-form-edit-lock.test.tsx` と同じやり方)。
 *
 * ⚠「帯が出る」の判断自体・fail openの通知条件(shouldShowLockUnavailableNotice)・
 *   保存可否の判断(canSubmitSave)は Task 5 で既に検査済みの純関数をそのまま再利用
 *   しているだけなので、ここでは重複して内部ロジックを検査しない(YAGNI)。
 *   ここで固定するのは「所有者カードがそれらを正しい引数で呼んでいるか」だけ。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { updateOwner } from "@/lib/api-client";
import { runOwnerLockAcquire } from "../page";
import { EDIT_SCREEN_HEADER, EDIT_LOCK_HEADER } from "@/lib/edit-lock/header-names";
import {
  setScreenTokenEnvForTest,
  resetScreenTokenForTest,
  type ScreenTokenEnv,
} from "@/lib/edit-lock/screen-token-client";

const PAGE_PATH = resolve(
  process.cwd(),
  "src/app/(dashboard)/properties/[id]/page.tsx",
);
const src = readFileSync(PAGE_PATH, "utf8");

/** `getScreenToken()` が固定の合言葉を返すだけの、最小限のフェイク env。 */
function fakeScreenTokenEnv(token: string): ScreenTokenEnv {
  return {
    getItem: () => token,
    setItem: () => {},
    openChannel: () => null,
    newId: () => token,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** `fetch` の型(url, init) を1箇所に固定し、mock.calls の要素型を保つ(edit-lock-client.test.ts と同じ形)。 */
function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(handler);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const OWNER_CARD_MARKER = "function OwnerCard({";

/**
 * `OwnerCard` **本体だけ**を切り出す(branch review Minor #4)。
 * ⚠`src.slice(ownerCardIndex)` は末尾までそのまま返るため、実際には
 *   `PropertyOwnerNoteEditor` 以降(12個のコンポーネント)も含んでしまい、
 *   「OwnerCard本体だけ」という前提が崩れる。次の `\nfunction ` の手前で切る。
 */
function extractOwnerCardSource(source: string): string {
  const start = source.indexOf(OWNER_CARD_MARKER);
  if (start === -1) return "";
  const bodyStart = start + OWNER_CARD_MARKER.length;
  const nextFunction = source.slice(bodyStart).match(/\nfunction /);
  const end = nextFunction ? bodyStart + nextFunction.index! : source.length;
  return source.slice(start, end);
}

describe("updateOwner(所有者の更新)のヘッダ", () => {
  beforeEach(() => {
    resetScreenTokenForTest();
    setScreenTokenEnvForTest(fakeScreenTokenEnv("screen-1"));
  });
  afterEach(() => {
    setScreenTokenEnvForTest(null);
    resetScreenTokenForTest();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("1) opts.lockIdを渡すとX-Edit-Lockにその値を載せる(合言葉も同時に載る)", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse({ id: "o1", name: "x", note: null, version: 2 }),
    );

    await updateOwner("o1", { version: 1 }, { lockId: "l1" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/owners/o1");
    expect(init?.method).toBe("PATCH");
    const headers = init?.headers as Record<string, string>;
    expect(headers[EDIT_LOCK_HEADER]).toBe("l1");
    expect(headers[EDIT_SCREEN_HEADER]).toBe("screen-1");
  });

  it("2) 第3引数(opts)を省略するとX-Edit-Screenだけを載せ、X-Edit-Lockは載せない(鍵を持たない既存の呼び出し元と同じ形)", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse({ id: "o1", name: "x", note: null, version: 2 }),
    );

    await updateOwner("o1", { version: 1 });

    const [, init] = fetchMock.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers[EDIT_SCREEN_HEADER]).toBe("screen-1");
    expect(EDIT_LOCK_HEADER in headers).toBe(false);
  });

  it("3) lockIdがnullのときもX-Edit-Lockは載せない(取得できていない状態と同じ扱い)", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse({ id: "o1", name: "x", note: null, version: 2 }),
    );

    await updateOwner("o1", { version: 1 }, { lockId: null });

    const [, init] = fetchMock.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(EDIT_LOCK_HEADER in headers).toBe(false);
  });
});

describe("runOwnerLockAcquire(所有者カードの取得・fail open)", () => {
  it("acquireが成功すればlockUnavailableをfalseにする", async () => {
    const setLockUnavailable = vi.fn();
    await runOwnerLockAcquire(() => Promise.resolve(), setLockUnavailable);
    expect(setLockUnavailable).toHaveBeenCalledTimes(1);
    expect(setLockUnavailable).toHaveBeenCalledWith(false);
  });

  it("acquireが失敗しても例外を投げず、lockUnavailableをtrueにする(fail open)", async () => {
    const setLockUnavailable = vi.fn();
    await expect(
      runOwnerLockAcquire(
        () => Promise.reject(new Error("EDIT_LOCK_ACQUIRE_FAILED")),
        setLockUnavailable,
      ),
    ).resolves.toBeUndefined();
    expect(setLockUnavailable).toHaveBeenCalledTimes(1);
    expect(setLockUnavailable).toHaveBeenCalledWith(true);
  });
});

describe("所有者カードの配線(source assertion)", () => {
  it("4) useEditLock・EditLockBanner(要素として)を含み、updateOwnerの第3引数にlock.lockIdを渡す", () => {
    expect(src).toContain("useEditLock(");
    // ⚠(branch review Minor #5) import行だけでも "EditLockBanner" という文字列は
    //   含まれてしまう(要素を削ってもこの検査は落ちない)。要素として描画している
    //   ことをpropsごと固定する。
    expect(src).toMatch(/<EditLockBanner state=\{lock\.state\}/);
    expect(src).toMatch(
      /updateOwner\(po\.ownerId,[\s\S]*?\{\s*lockId:\s*lock\.lockId,?\s*\}/,
    );
  });

  it("保存の失敗はapiErrorCode(err)の戻り値をそのままnoteSaveErrorへ渡す(写像はTask2の純関数に任せる)", () => {
    // ⚠(branch review Important #1) 文字列が「どこかに」あるかだけの検査だと、
    //   `lock.noteSaveError(null, null)` のような書き換え(423の帯が二度と出なく
    //   なる回帰)でも green のままになる。引数そのものを固定する。
    // ⚠(横断レビューI2) 423の文言組み立てのために読んだコードを変数へ受けるように
    //   なったので、その式ごと固定する(意味は同じ=読んだコードをそのまま渡す)。
    expect(src).toMatch(/const code = apiErrorCode\(err\);/);
    expect(src).toMatch(/lock\.noteSaveError\(code, null\)/);
  });

  it("(横断レビューI2) 保存が423 EDIT_LOCKED のときは showComposedEditLockedMessage で氏名+時刻へ差し替える", () => {
    // ⚠封筒の423は氏名も時刻も返さない(段階1のサーバのまま)。鍵を持たない3入口と
    //   同じ helper を通す。第1・第2引数がこのカードの資源(owner・po.ownerId)で
    //   あることも固定する(物件の資源IDを渡す取り違えを落とす)。
    expect(src).toMatch(/showComposedEditLockedMessage\(\s*"owner",\s*po\.ownerId,/);
  });

  it("(仕上げround2) 同じ1回の問い合わせの結果を帯にも渡す(noteSaveErrorHolderへ配線する)", () => {
    // ⚠この配線が無いと、エラー表示は「佐藤さんが編集中です(14:02〜)」と実名を
    //   名乗るのに、すぐ上の帯は「他の利用者さんが編集を始めました」と言い続ける。
    //   帯のためだけに2回目を引かないよう、同じ helper の第5引数で受け取る。
    expect(src).toMatch(
      /showComposedEditLockedMessage\([\s\S]*?lock\.noteSaveErrorHolder\(holder\.holderName, holder\.since\)/,
    );
  });

  it("編集フォームはinput・keydown・pointerdownの3つでnoteActivityを呼ぶ(期限切れの取り直しの引き金)", () => {
    // ⚠(branch review Important #2) 「入力・キー・ポインタ」と名乗るテストが
    //   `noteActivity()` の出現を1回しか見ていないと、onInput/onKeyDownを消しても
    //   onPointerDownの1個だけで green になる。3つとも個別に固定する。
    expect(src).toMatch(/onInput=\{\(\) => lock\.noteActivity\(\)\}/);
    expect(src).toMatch(/onKeyDown=\{\(\) => lock\.noteActivity\(\)\}/);
    expect(src).toMatch(/onPointerDown=\{\(\) => lock\.noteActivity\(\)\}/);
  });

  it("保存ボタンのdisabledはcanSubmitSaveの戻り値を含む(Task5の判断をそのまま再利用)", () => {
    expect(src).toMatch(/!canSubmitSave\(\{\s*tokenReady:\s*editLockTokenReady/);
  });

  it("(横断レビューI1) canSubmitSaveへ鍵の状態(lock.state.kind)も渡す=fail openの旗が帯を上書きしない", () => {
    // ⚠これが抜けると、取得が失敗したあと423で帯が「この内容は保存できません」と
    //   出ているのに保存ボタンだけ押せる自己矛盾に戻る。固定値を渡す退行も落とす
    //   ため、`lock.state.kind` という式そのものを要求する。
    expect(src).toMatch(/canSubmitSave\(\{[\s\S]*?stateKind:\s*lock\.state\.kind/);
  });

  it("fail openの通知はshouldShowLockUnavailableNotice経由(Task5の判断をそのまま再利用)", () => {
    // ⚠(branch review Minor #6) 第1引数(lockUnavailable)だけを固定すると、
    //   idle以外で通知を消す第2引数(lock.state.kind)側が抜け落ちても green になる。
    //   両方の引数を固定する。
    expect(src).toMatch(
      /shouldShowLockUnavailableNotice\(\s*lockUnavailable,\s*lock\.state\.kind\s*\)/,
    );
  });
});

describe("所有者ごとに独立した鍵(per-owner independence・カードは資源IDを混ぜない)", () => {
  // OwnerCard 本体だけを見る(走査ヘルパーの定義や他のコンポーネントを含めない)。
  const ownerCardIndex = src.indexOf(OWNER_CARD_MARKER);
  const ownerCardSrc = extractOwnerCardSource(src);

  it("OwnerCardが実在する", () => {
    expect(ownerCardIndex).toBeGreaterThan(-1);
  });

  it("5) useEditLockのresourceIdはこのカードのpo.ownerId(固定文字列や親由来の共有変数ではない)", () => {
    // ⚠「一枚のカードの鍵がほかのカードを止める」という壊れ方は、大抵ここが
    //   すべてのカードで同じ値(例: owners[0].ownerId のような共有値)になる
    //   ことで起きる。po はこのカードの props なので、カードごとに別の値になる。
    expect(ownerCardSrc).toMatch(
      /useEditLock\(\{\s*resourceType:\s*"owner",\s*resourceId:\s*po\.ownerId,/,
    );
  });

  it("6) enabledはこのカード自身のeditingフラグに紐づく(他のカードの状態を読まない)", () => {
    expect(ownerCardSrc).toMatch(/enabled:\s*editing\s*&&\s*editLockTokenReady,/);
  });
});

describe("複製タブ確認は画面につき1回だけ(once per page・Task 6の要件)", () => {
  // ⚠(外部レビュー@codex P1 round2) 応答器+複製タブ確認の一生は
  //   useEditScreenToken() hook に括り出した(鍵のヘッダを送る画面はすべて呼ぶ契約。
  //   詳細は screen-token-client.test.ts の導出型ラチェット)。ここでの関心は変わらず
  //   「page.tsx全体でちょうど1回・OwnerCardより前・OwnerCard自身は呼ばない」。
  it("7) useEditScreenTokenの呼び出しはpage.tsx全体でちょうど1回(カードごとに増えない)", () => {
    const calls = src.match(/useEditScreenToken\(\)/g) ?? [];
    expect(calls.length).toBe(1);
  });

  it("8) その1回はOwnerCardより前(=親の物件詳細画面側)にある", () => {
    const ownerCardIndex = src.indexOf("function OwnerCard({");
    const tokenCallIndex = src.indexOf("useEditScreenToken()");
    expect(ownerCardIndex).toBeGreaterThan(-1);
    expect(tokenCallIndex).toBeGreaterThan(-1);
    expect(tokenCallIndex).toBeLessThan(ownerCardIndex);
  });

  it("9) OwnerCard自身のソースはuseEditScreenToken/ensureUniqueScreenTokenを呼ばない(カードごとに300ms待たせない)", () => {
    const ownerCardSrc = extractOwnerCardSource(src);
    expect(ownerCardSrc).not.toContain("useEditScreenToken(");
    expect(ownerCardSrc).not.toContain("ensureUniqueScreenToken(");
  });
});
