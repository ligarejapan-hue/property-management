/**
 * api-client の「編集中の鍵」窓口5本+beaconの、契約が特殊な部分を検証する。
 *
 * ⚠この節の窓口は USE_MOCK を見ない(サーバ側5本は本番に既に live)ので、
 *   address-lookup-client.test.ts と違い vi.resetModules()/vi.stubEnv は使わない
 *   (resetModules すると、この test ファイルが静的 import した
 *   screen-token-client と、動的 import し直した api-client が別モジュール
 *   インスタンスの screen-token-client を掴み、setScreenTokenEnvForTest が効かなくなる)。
 *
 * 検証の主眼:
 *  - acquire の 423 は**エラーにせず**裸の応答をそのまま返す(uiStateFromAcquire が消費)。
 *  - heartbeat の 404 は `{notFound:true}` に畳む(uiStateFromHeartbeat の "deleted" 入力)。
 *  - release は常に 200 の契約だが、fetch 自体が失敗しても画面を止めない(catch)。
 *  - ヘッダは editLockHeaders() 経由(合言葉+鍵の世代)だけを使う。
 *  - beacon はヘッダを使えないので合言葉を本文(screenToken)で送る。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  acquireEditLockApi,
  heartbeatEditLockApi,
  releaseEditLockApi,
  forceReleaseEditLockApi,
  fetchEditLockStatus,
  releaseEditLockByBeacon,
  apiErrorCode,
} from "../api-client";
import { EDIT_SCREEN_HEADER, EDIT_LOCK_HEADER } from "../edit-lock/header-names";
import { setScreenTokenEnvForTest, resetScreenTokenForTest } from "../edit-lock/screen-token-client";

const TOKEN = "11111111-1111-4111-8111-111111111111";
const LOCK_ID = "22222222-2222-4222-8222-222222222222";
const PROPERTY_ID = "33333333-3333-4333-8333-333333333333";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** `fetch` の型(url, init) を1箇所に固定し、mock.calls の要素型を保つ。 */
function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(handler);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("edit-lock api-client", () => {
  beforeEach(() => {
    // 合言葉を固定する(採番のたびに変わると header 検証が書けない)。
    setScreenTokenEnvForTest({
      getItem: () => TOKEN,
      setItem: () => {},
      openChannel: () => null,
      newId: () => TOKEN,
    });
  });
  afterEach(() => {
    resetScreenTokenForTest();
    setScreenTokenEnvForTest(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("acquireEditLockApi: 200 は裸の mine 応答を返す。ヘッダに合言葉だけを付ける", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse({ state: "mine", lockId: LOCK_ID, since: "2026-09-22T01:00:00.000Z" }),
    );

    const res = await acquireEditLockApi("property", PROPERTY_ID);
    expect(res).toEqual({ state: "mine", lockId: LOCK_ID, since: "2026-09-22T01:00:00.000Z" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/edit-locks/acquire");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers[EDIT_SCREEN_HEADER]).toBe(TOKEN);
    expect(headers[EDIT_LOCK_HEADER]).toBeUndefined();
    expect(JSON.parse(init?.body as string)).toEqual({ resourceType: "property", resourceId: PROPERTY_ID });
  });

  it("acquireEditLockApi: 423(他の人が持っている)はエラーを投げず裸の held 応答を返す", async () => {
    const held = { code: "EDIT_LOCKED", state: "held_by_other", holderName: "山田", since: "2026-09-22T01:00:00.000Z" };
    stubFetch(async () => jsonResponse(held, 423));

    await expect(acquireEditLockApi("property", PROPERTY_ID)).resolves.toEqual(held);
  });

  it("acquireEditLockApi: 423 以外の非2xx はエラーとして投げる", async () => {
    stubFetch(async () =>
      jsonResponse({ error: { message: "画面の識別子がありません", code: "EDIT_SCREEN_REQUIRED" } }, 400),
    );

    await expect(acquireEditLockApi("property", PROPERTY_ID)).rejects.toThrow("画面の識別子がありません");
  });

  it("heartbeatEditLockApi: 200 は state を素通しし、active をそのまま body に載せる", async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ state: "mine", idleSince: "2026-09-22T01:10:00.000Z" }));

    const res = await heartbeatEditLockApi("property", PROPERTY_ID, true);
    expect(res).toEqual({ state: "mine", idleSince: "2026-09-22T01:10:00.000Z" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/edit-locks/heartbeat");
    expect(JSON.parse(init?.body as string)).toEqual({ resourceType: "property", resourceId: PROPERTY_ID, active: true });
  });

  it("heartbeatEditLockApi: 404(資源が消えた)は {notFound:true} に畳む(投げない)", async () => {
    stubFetch(async () => jsonResponse({ error: { message: "物件が見つかりません", code: "NOT_FOUND" } }, 404));

    await expect(heartbeatEditLockApi("property", PROPERTY_ID, false)).resolves.toEqual({ notFound: true });
  });

  it("releaseEditLockApi: 常に解決する。fetch が reject しても画面を止めない", async () => {
    stubFetch(async () => {
      throw new Error("network down");
    });

    await expect(releaseEditLockApi("property", PROPERTY_ID, LOCK_ID)).resolves.toBeUndefined();
  });

  it("releaseEditLockApi: resourceType/resourceId/lockId を body に、合言葉をヘッダに送る", async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ ok: true }));

    await releaseEditLockApi("property", PROPERTY_ID, LOCK_ID);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/edit-locks/release");
    expect(JSON.parse(init?.body as string)).toEqual({ resourceType: "property", resourceId: PROPERTY_ID, lockId: LOCK_ID });
    expect((init?.headers as Record<string, string>)[EDIT_SCREEN_HEADER]).toBe(TOKEN);
  });

  it("forceReleaseEditLockApi: 409 EDIT_LOCK_CHANGED は封筒のエラーとして投げる", async () => {
    stubFetch(async () =>
      jsonResponse(
        { error: { message: "鍵の状態が変わりました。もう一度お試しください", code: "EDIT_LOCK_CHANGED" } },
        409,
      ),
    );

    let caught: unknown = null;
    await forceReleaseEditLockApi("property", PROPERTY_ID, LOCK_ID).catch((e: unknown) => {
      caught = e;
    });
    expect(caught).not.toBeNull();
    expect(apiErrorCode(caught)).toBe("EDIT_LOCK_CHANGED");
  });

  it("fetchEditLockStatus: 空配列なら fetch すら呼ばない(1回50件までの窓口を無駄に叩かない)", async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ locks: [] }));
    fetchMock.mockClear();

    await expect(fetchEditLockStatus([])).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetchEditLockStatus: resources を body に載せて呼び、locks をそのまま返す", async () => {
    const rows = [{ resourceType: "property" as const, resourceId: PROPERTY_ID, state: "free" as const }];
    const fetchMock = stubFetch(async () => jsonResponse({ locks: rows }));

    const res = await fetchEditLockStatus([{ resourceType: "property", resourceId: PROPERTY_ID }]);
    expect(res).toEqual(rows);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/edit-locks/status");
    expect(JSON.parse(init?.body as string)).toEqual({ resources: [{ resourceType: "property", resourceId: PROPERTY_ID }] });
  });

  it("releaseEditLockByBeacon: sendBeacon の本文に合言葉(screenToken)を積む(ヘッダが使えないため)", async () => {
    const sendBeaconMock = vi.fn((_url: string, _data?: BodyInit): boolean => true);
    vi.stubGlobal("navigator", { sendBeacon: sendBeaconMock } as unknown as Navigator);

    releaseEditLockByBeacon("property", PROPERTY_ID, LOCK_ID);

    expect(sendBeaconMock).toHaveBeenCalledTimes(1);
    const [url, blob] = sendBeaconMock.mock.calls[0];
    expect(url).toBe("/api/edit-locks/release");
    const text = await (blob as Blob).text();
    expect(JSON.parse(text)).toEqual({
      resourceType: "property",
      resourceId: PROPERTY_ID,
      lockId: LOCK_ID,
      screenToken: TOKEN,
    });
  });

  it("releaseEditLockByBeacon: sendBeacon が無い/例外を投げても画面を止めない", async () => {
    vi.stubGlobal("navigator", {
      sendBeacon: () => {
        throw new Error("not supported");
      },
    } as unknown as Navigator);

    expect(() => releaseEditLockByBeacon("property", PROPERTY_ID, LOCK_ID)).not.toThrow();
  });
});
