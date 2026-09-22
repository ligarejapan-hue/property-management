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
  it("4) useEditLock・EditLockBannerを含み、updateOwnerの第3引数にlock.lockIdを渡す", () => {
    expect(src).toContain("useEditLock(");
    expect(src).toContain("EditLockBanner");
    expect(src).toMatch(
      /updateOwner\(po\.ownerId,[\s\S]*?\{\s*lockId:\s*lock\.lockId,?\s*\}/,
    );
  });

  it("保存の失敗はapiErrorCodeで読んだコードをnoteSaveErrorへ渡す(写像はTask2の純関数に任せる)", () => {
    expect(src).toContain("apiErrorCode(");
    expect(src).toContain("noteSaveError(");
  });

  it("入力・キー・ポインタでnoteActivityを呼ぶ(期限切れの取り直しの引き金)", () => {
    expect(src).toContain("noteActivity()");
  });

  it("保存ボタンのdisabledはcanSubmitSaveの戻り値を含む(Task5の判断をそのまま再利用)", () => {
    expect(src).toMatch(/!canSubmitSave\(\{\s*tokenReady:\s*editLockTokenReady/);
  });

  it("fail openの通知はshouldShowLockUnavailableNotice経由(Task5の判断をそのまま再利用)", () => {
    expect(src).toMatch(/shouldShowLockUnavailableNotice\(\s*lockUnavailable/);
  });
});

describe("所有者ごとに独立した鍵(per-owner independence・カードは資源IDを混ぜない)", () => {
  // OwnerCard 本体だけを見る(走査ヘルパーの定義や他のコンポーネントを含めない)。
  const OWNER_CARD_MARKER = "function OwnerCard({";
  const ownerCardIndex = src.indexOf(OWNER_CARD_MARKER);
  const ownerCardSrc = src.slice(ownerCardIndex);

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
  it("7) ensureUniqueScreenTokenの呼び出しはpage.tsx全体でちょうど1回(カードごとに増えない)", () => {
    const calls = src.match(/ensureUniqueScreenToken\(\)/g) ?? [];
    expect(calls.length).toBe(1);
  });

  it("8) その1回はOwnerCardより前(=親の物件詳細画面側)にある", () => {
    const ownerCardIndex = src.indexOf("function OwnerCard({");
    const tokenCallIndex = src.indexOf("ensureUniqueScreenToken()");
    expect(ownerCardIndex).toBeGreaterThan(-1);
    expect(tokenCallIndex).toBeGreaterThan(-1);
    expect(tokenCallIndex).toBeLessThan(ownerCardIndex);
  });

  it("9) OwnerCard自身のソースはensureUniqueScreenTokenを呼ばない(カードごとに300ms待たせない)", () => {
    const ownerCardIndex = src.indexOf("function OwnerCard({");
    const ownerCardSrc = src.slice(ownerCardIndex);
    expect(ownerCardSrc).not.toContain("ensureUniqueScreenToken(");
  });
});
