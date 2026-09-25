/**
 * 法人番号の反映パネル(corporate-lookup-panel.tsx)に配線した編集中の鍵
 * (仕様 6.1・6.5・Task 8・6入口目)を node で検証する。
 *
 * このパネルは**物件詳細の所有者カード内**と **`admin/owners/[id]`** の2画面に
 * 置かれ、鍵の有無が画面ごとに変わる:
 * - 所有者カード内: カードが持つ鍵の世代(`lock.lockId`)を props で受け取り、
 *   反映の保存(`applyOwnerCorporate`)に `X-Edit-Lock` として載せる。
 * - `admin/owners/[id]`: 鍵を持たない入口。合言葉(`X-Edit-Screen`)だけを送り、
 *   423 のときはこのパネル自身が氏名+時刻の文言を組み立てて表示する(仕様6.5)。
 *
 * ⚠このリポジトリは jsdom を使わない方針(vitest.config.ts が environment: "node" を
 *   固定)。パネルを描画してクリックするテストは書けないので、
 *   - `applyOwnerCorporate` のヘッダ組み立て(第3引数 opts.lockId)
 *   - 423 の文言組み立て(`handleCorporateApplyEditLockedError`・node から直接呼ぶ)
 *   の2つは実際に関数を呼んで node で検証し、
 *   - 配線そのもの(2画面での lockId の受け渡し)
 *   は走査(source assertion)で固定する(`owner-card-edit-lock.test.tsx` と同じやり方)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyOwnerCorporate, apiErrorCode } from "@/lib/api-client";
import { handleCorporateApplyEditLockedError } from "../corporate-lookup-panel";
import { EDIT_SCREEN_HEADER, EDIT_LOCK_HEADER } from "@/lib/edit-lock/header-names";
import { setScreenTokenEnvForTest, resetScreenTokenForTest } from "@/lib/edit-lock/screen-token-client";
import {
  fakeScreenTokenEnv,
  jsonResponse,
  stubFetch,
  stubFetchByUrl,
  flushAsync,
  createStateSpy,
} from "@/lib/edit-lock/__tests__/test-helpers";

const PROPERTY_PAGE_PATH = join(
  process.cwd(),
  "src/app/(dashboard)/properties/[id]/page.tsx",
);
const ADMIN_OWNER_PAGE_PATH = join(
  process.cwd(),
  "src/app/(dashboard)/admin/owners/[id]/page.tsx",
);
const PANEL_PATH = join(process.cwd(), "src/components/owners/corporate-lookup-panel.tsx");

const propertyPageSrc = readFileSync(PROPERTY_PAGE_PATH, "utf8").replace(/\r\n/g, "\n");
const adminOwnerPageSrc = readFileSync(ADMIN_OWNER_PAGE_PATH, "utf8").replace(/\r\n/g, "\n");
const panelSrc = readFileSync(PANEL_PATH, "utf8").replace(/\r\n/g, "\n");

const BASE_PAYLOAD = {
  corporateNumber: "1234567890123",
  version: 1,
  apply: { name: true, address: false, zip: false, corporateNumber: false },
  expectedRecord: {
    corporateNumber: "1234567890123",
    name: "モック株式会社",
    address: "東京都千代田区丸の内1-1-1",
    postCode: null,
    updateDate: null,
  },
};

describe("画面ごとに世代の有無が変わる(source assertion)", () => {
  it("カード内(物件詳細の所有者カード)ではCorporateLookupPanelにカードの世代(lock.lockId)を渡す", () => {
    expect(propertyPageSrc).toMatch(/<CorporateLookupPanel[\s\S]{0,900}?lockId=\{lock\.lockId\}/);
  });

  it("管理画面(admin/owners/[id])ではlockIdを渡さない(合言葉だけの入口)", () => {
    const block = adminOwnerPageSrc.match(/<CorporateLookupPanel[\s\S]*?\/>/)?.[0];
    expect(block).toBeTruthy();
    expect(block).not.toMatch(/lockId=/);
  });

  it("パネル自身は受け取ったlockIdをapplyOwnerCorporateの第3引数へそのまま渡す(手組みしない)", () => {
    expect(panelSrc).toMatch(/applyOwnerCorporate\(\s*ownerId,[\s\S]*?\{\s*lockId,?\s*\}/);
  });
});

describe("applyOwnerCorporate(法人番号の反映)のヘッダ", () => {
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
      jsonResponse({ ok: true, owner: { id: "o1", version: 2 } }),
    );
    await applyOwnerCorporate("o1", BASE_PAYLOAD, { lockId: "l1" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/owners/o1/corporate-apply");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers[EDIT_LOCK_HEADER]).toBe("l1");
    expect(headers[EDIT_SCREEN_HEADER]).toBe("screen-1");
  });

  it("2) 第3引数(opts)を省略するとX-Edit-Screenだけを載せ、X-Edit-Lockは載せない(鍵を持たない既存の呼び出し元と同じ形)", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse({ ok: true, owner: { id: "o1", version: 2 } }),
    );
    await applyOwnerCorporate("o1", BASE_PAYLOAD);

    const [, init] = fetchMock.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers[EDIT_SCREEN_HEADER]).toBe("screen-1");
    expect(EDIT_LOCK_HEADER in headers).toBe(false);
  });

  it("3) lockIdがnullのときもX-Edit-Lockは載せない(取得できていない状態と同じ扱い)", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse({ ok: true, owner: { id: "o1", version: 2 } }),
    );
    await applyOwnerCorporate("o1", BASE_PAYLOAD, { lockId: null });

    const [, init] = fetchMock.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(EDIT_LOCK_HEADER in headers).toBe(false);
  });

  it("bodyは従来どおりpayloadそのまま(ヘッダの追加以外は挙動を変えない)", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse({ ok: true, owner: { id: "o1", version: 2 } }),
    );
    await applyOwnerCorporate("o1", BASE_PAYLOAD, { lockId: "l1" });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual(BASE_PAYLOAD);
  });
});

/**
 * handleCorporateApplyEditLockedError(423のとき既存のエラー位置に文言が出る・仕様6.5)。
 * ⚠registry-chiban-popup.tsx / page.tsx の同種テストと同じ構造(review round1〜3の
 *   教訓をそのまま踏襲)。
 */
describe("handleCorporateApplyEditLockedError(鍵を持たない入口としての反映エラー・node で直接呼ぶ)", () => {
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

  it("EDIT_LOCKED以外はfalseを返し、applyErrorに一切触らない(既存の msg.includes 分岐を壊さない)", () => {
    const error = createStateSpy<string | null>(null);
    const err = Object.assign(new Error("他のユーザーが先に更新しました"), { code: "CONFLICT" });
    expect(apiErrorCode(err)).toBe("CONFLICT");
    const handled = handleCorporateApplyEditLockedError(err, "o1", error.setState);
    expect(handled).toBe(false);
    expect(error.calls.length).toBe(0);
  });

  it("Errorインスタンスでない値が来てもfalseを返す(型ガード)", () => {
    const error = createStateSpy<string | null>(null);
    const handled = handleCorporateApplyEditLockedError("boom", "o1", error.setState);
    expect(handled).toBe(false);
    expect(error.calls.length).toBe(0);
  });

  it("EDIT_LOCKED + 状態窓口が保持者行を返せば、氏名+時刻の文を組み立てて表示する(仕様6.5)", async () => {
    const since = new Date(2026, 8, 22, 14, 0).toISOString();
    stubFetchByUrl({
      "/api/edit-locks/status": async () =>
        jsonResponse({
          locks: [
            {
              resourceType: "owner",
              resourceId: "o1",
              state: "held_by_other",
              since,
              holderName: "太郎",
            },
          ],
        }),
    });
    const error = createStateSpy<string | null>(null);
    const err = Object.assign(new Error("他の画面で編集中です"), { code: "EDIT_LOCKED" });
    const handled = handleCorporateApplyEditLockedError(err, "o1", error.setState);
    expect(handled).toBe(true);
    // ⚠(carried item 2) setApplyError(null)-at-save-startはhandleApply側が既に
    //   持つ責務であってこの関数の責務ではないため、ここでは封筒のmessageが
    //   最初の呼び出しであることだけを見る(この関数自体はリセットしない)。
    expect(error.calls[0]).toBe("他の画面で編集中です");
    expect(error.value).toBe("他の画面で編集中です");
    await flushAsync();
    expect(error.value).toBe("太郎さんが編集中です(14:00〜)");
  });

  it("状態窓口への問い合わせが失敗すれば、封筒のmessageへフォールバックする", async () => {
    stubFetchByUrl({
      "/api/edit-locks/status": async () => jsonResponse({ error: { message: "エラー" } }, 500),
    });
    const error = createStateSpy<string | null>(null);
    const err = Object.assign(new Error("他の画面で編集中です"), { code: "EDIT_LOCKED" });
    handleCorporateApplyEditLockedError(err, "o1", error.setState);
    await flushAsync();
    expect(error.value).toBe("他の画面で編集中です");
  });

  it("成功で消えたエラーへ、遅れて届いた組み立てが後から生えない(review round3 Important G)", async () => {
    const statusResolver: { resolve: ((res: Response) => void) | null } = { resolve: null };
    stubFetchByUrl({
      "/api/edit-locks/status": () =>
        new Promise<Response>((resolve) => {
          statusResolver.resolve = resolve;
        }),
    });
    const error = createStateSpy<string | null>(null);
    const err = Object.assign(new Error("他の画面で編集中です"), { code: "EDIT_LOCKED" });
    handleCorporateApplyEditLockedError(err, "o1", error.setState);
    expect(error.value).toBe("他の画面で編集中です");
    // 控えは既に解放されているため、利用者が再反映を成功させ得る(round2 Important Aの副作用)。
    error.setState(null);
    expect(error.value).toBeNull();
    statusResolver.resolve?.(
      jsonResponse({
        locks: [
          {
            resourceType: "owner",
            resourceId: "o1",
            state: "held_by_other",
            since: new Date(2026, 8, 22, 14, 0).toISOString(),
            holderName: "太郎",
          },
        ],
      }),
    );
    await flushAsync();
    expect(error.value).toBeNull();
  });

  it("後着の同文言のrefusalは、先着の古い組み立てに上書きされない(caller-owned sequence number・review round3 K)", async () => {
    const since = new Date(2026, 8, 22, 14, 0).toISOString();
    const holderRow = (name: string) => ({
      locks: [
        {
          resourceType: "owner" as const,
          resourceId: "o1",
          state: "held_by_other" as const,
          since,
          holderName: name,
        },
      ],
    });
    const resolvers: Array<(res: Response) => void> = [];
    let call = 0;
    stubFetchByUrl({
      "/api/edit-locks/status": () =>
        new Promise<Response>((resolve) => {
          resolvers[call++] = resolve;
        }),
    });
    const error = createStateSpy<string | null>(null);
    const seqRef = { current: 0 };
    const err = Object.assign(new Error("他の画面で編集中です"), { code: "EDIT_LOCKED" });
    handleCorporateApplyEditLockedError(err, "o1", error.setState, seqRef);
    handleCorporateApplyEditLockedError(err, "o1", error.setState, seqRef);
    expect(error.value).toBe("他の画面で編集中です");
    // 1回目(太郎)の組み立てが先に届く＝世代が古いので、封筒のままでも上書きしない。
    resolvers[0]?.(jsonResponse(holderRow("太郎")));
    await flushAsync();
    expect(error.value).toBe("他の画面で編集中です");
    // 2回目(次郎)の組み立てが後から届く＝これが最新なので反映する。
    resolvers[1]?.(jsonResponse(holderRow("次郎")));
    await flushAsync();
    expect(error.value).toBe("次郎さんが編集中です(14:00〜)");
  });

  it("seqRefを省略した2回の呼び出しはそれぞれ独立(常に自分が最新=従来どおり)", async () => {
    const since = new Date(2026, 8, 22, 14, 0).toISOString();
    stubFetchByUrl({
      "/api/edit-locks/status": async () =>
        jsonResponse({
          locks: [
            {
              resourceType: "owner",
              resourceId: "o1",
              state: "held_by_other",
              since,
              holderName: "太郎",
            },
          ],
        }),
    });
    const error = createStateSpy<string | null>(null);
    const err = Object.assign(new Error("他の画面で編集中です"), { code: "EDIT_LOCKED" });
    handleCorporateApplyEditLockedError(err, "o1", error.setState);
    await flushAsync();
    expect(error.value).toBe("太郎さんが編集中です(14:00〜)");
  });
});
