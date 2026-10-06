import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRegistryClient, FetchError, REGISTRY_USER_AGENT } from "@/lib/agent-registry/client";

const fixture = (name: string) =>
  readFileSync(join(process.cwd(), "src/lib/agent-registry/__tests__/fixtures", name), "utf8");
const listHtml = fixture("list.html");
/** 見本の一覧(東京都=13)を別の行政庁のページに書き換える。 */
const VISIBLE: Record<string, string> = { "00": "国土交通大臣", "11": "埼玉県", "12": "千葉県", "13": "東京都", "14": "神奈川県" };
const listFor = (a: string) =>
  listHtml
    .replaceAll("js_ShowDetail('13", `js_ShowDetail('${a}`)
    .replaceAll('value="13"', `value="${a}"`)
    .replaceAll(">東京都<", `>${VISIBLE[a]}<`);
const detailHtml = fixture("detail.html");
const searchPageHtml = '<form id="tkModel" name="tkModel" action="takkenKensaku.do" method="post"></form>';

type Call = { url: string; method: string; body: string; headers: Record<string, string> };

/** 偽の先方。呼ばれた順に応答を返す。時計は sleep で進む。 */
function setup(responses: Array<(c: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  let clock = 1_000_000;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call: Call = { url: String(url), method: init?.method ?? "GET", body: String(init?.body ?? ""), headers };
    calls.push(call);
    const next = responses.shift();
    if (!next) throw new Error("想定より多く呼ばれた");
    clock += 10; // 応答にかかった時間
    return next(call);
  }) as typeof fetch;
  const client = createRegistryClient({
    fetchImpl,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    decode: (buf) => new TextDecoder("utf-8").decode(buf),
  });
  return { client, calls, sleeps };
}

const html = (body: string, init: ResponseInit = {}) =>
  new Response(body, { status: 200, headers: { "set-cookie": "JSESSIONID=abc123; Path=/TAKKEN" }, ...init });

const form = (c: Call) => Object.fromEntries(new URLSearchParams(c.body));

describe("先方への取得", () => {
  it("最初に検索画面を開いて cookie を受け取り、以後の呼び出しで送り返す・名乗りの見出し", async () => {
    const { client, calls } = setup([() => html(searchPageHtml), () => html(listHtml)]);
    const page = await client.searchFirst("13");
    expect(page.total).toBe(26906);
    expect(calls[0].url).toBe("https://etsuran2.mlit.go.jp/TAKKEN/takkenKensaku.do?outPutKbn=1");
    expect(calls[0].method).toBe("GET");
    expect(calls[1].url).toBe("https://etsuran2.mlit.go.jp/TAKKEN/takkenKensaku.do");
    expect(calls[1].method).toBe("POST");
    expect(calls[1].headers.cookie).toBe("JSESSIONID=abc123");
    for (const c of calls) expect(c.headers["user-agent"]).toBe(REGISTRY_USER_AGENT);
  });

  it("検索で送る項目: 免許行政庁・50件ずつ・免許証番号順", async () => {
    const { client, calls } = setup([() => html(searchPageHtml), () => html(listFor("00"))]);
    await client.searchFirst("00");
    expect(form(calls[1])).toMatchObject({
      CMD: "search",
      licenseNoKbn: "00",
      dispCount: "50",
      sortValue: "1",
      caller: "TK",
    });
  });

  it("★2回目以降は前の呼び出しから4秒あける", async () => {
    const { client, sleeps } = setup([() => html(searchPageHtml), () => html(listHtml), () => html(detailHtml)]);
    await client.searchFirst("13");
    await client.detail("13000001");
    // 1回目(検索画面)は待たない。2回目・3回目は前から4秒(応答の10ミリ秒ぶんを引いた残り)
    expect(sleeps).toEqual([3990, 3990]);
    expect(client.requestCount).toBe(3);
  });

  it("★同時に呼ばれても1本ずつ順番に(重ならない)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const slow = (body: string) => async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return html(body);
    };
    const { client } = setup([slow(searchPageHtml), slow(detailHtml), slow(detailHtml), slow(detailHtml)]);
    await Promise.all([client.detail("13000001"), client.detail("13000001"), client.detail("13000001")]);
    expect(maxInFlight).toBe(1);
  });

  it("ページ送り: 直前の検索の隠し項目を送り返し、ページ番号を付ける", async () => {
    const { client, calls } = setup([() => html(searchPageHtml), () => html(listHtml), () => html(listHtml)]);
    await client.searchFirst("13");
    await client.selectPage("13", 2);
    const f = form(calls[2]);
    expect(f.CMD).toBe("selectPage");
    expect(f.pageListNo1).toBe("2");
    expect(f.pageListNo2).toBe("2");
    expect(f.sv_licenseNoKbn).toBe("13");
    expect(f.sv_dispCount).toBe("50");
  });

  it("別の行政庁のページ送りは、先にその行政庁で検索してから", async () => {
    const { client, calls } = setup([
      () => html(searchPageHtml),
      () => html(listHtml),
      () => html(listFor("14")),
      () => html(listFor("14")),
    ]);
    await client.searchFirst("13");
    await client.selectPage("14", 5);
    expect(form(calls[2])).toMatchObject({ CMD: "search", licenseNoKbn: "14" });
    expect(form(calls[3])).toMatchObject({ CMD: "selectPage", pageListNo1: "5" });
  });

  it("★ページ数より先のページは頼まない(止まっている間に件数が減った)→ 空の結果を返す", async () => {
    const { client, calls } = setup([() => html(searchPageHtml), () => html(listHtml)]);
    const page = await client.selectPage("13", 600); // 見本は 539 ページ
    expect(page).toEqual({ total: 26906, pages: 539, page: 600, rows: [] });
    expect(calls).toHaveLength(2); // 検索画面+1ページ目の検索だけ(600ページ目は頼まない)
  });

  it("★頼んだ行政庁と違う一覧(行の免許・隠し項目の行政庁)が返ったら layout で止める(@codex #477)", async () => {
    const a = setup([() => html(searchPageHtml), () => html(listFor("14"))]);
    expect(await a.client.searchFirst("13").catch((e) => e.kind)).toBe("layout");
    // 行は東京でも、隠し項目の行政庁が神奈川(次のページ送りが神奈川へ行ってしまう)
    const b = setup([() => html(searchPageHtml), () => html(listHtml.replace('id="sv_licenseNoKbn" name="sv_licenseNoKbn" type="hidden" value="13"', 'id="sv_licenseNoKbn" name="sv_licenseNoKbn" type="hidden" value="14"'))]);
    expect(await b.client.searchFirst("13").catch((e) => e.kind)).toBe("layout");
  });

  it("詳細: 免許の鍵を送る・読んだ値を返す", async () => {
    const { client, calls } = setup([() => html(searchPageHtml), () => html(detailHtml)]);
    const d = await client.detail("13000001");
    expect(calls[1].url).toBe("https://etsuran2.mlit.go.jp/TAKKEN/tkGaiyo.do");
    expect(form(calls[1]).sv_licenseNo).toBe("13000001");
    expect(d.phone).toBe("03-0000-1212");
  });

  it.each([
    [429, "http_429"],
    [503, "http_5xx"],
    [500, "http_5xx"],
    [404, "http_other"],
  ])("先方が %s → %s で止める(取り直さない)", async (status, kind) => {
    const { client, calls } = setup([() => html(searchPageHtml), () => html("busy", { status })]);
    await expect(client.searchFirst("13")).rejects.toMatchObject({ kind });
    expect(calls).toHaveLength(2);
  });

  it("時間切れ → timeout・つながらない → network", async () => {
    const abort = () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    };
    const a = setup([() => html(searchPageHtml), abort]);
    await expect(a.client.searchFirst("13")).rejects.toMatchObject({ kind: "timeout" });
    const b = setup([
      () => {
        throw new TypeError("fetch failed");
      },
    ]);
    await expect(b.client.searchFirst("13")).rejects.toMatchObject({ kind: "network" });
  });

  it("検索画面に戻された(セッション切れ)ときは1回だけ取り直す・2回目も読めなければ layout", async () => {
    const ok = setup([
      () => html(searchPageHtml),
      () => html(searchPageHtml), // 期限切れで検索画面に戻された
      () => html(searchPageHtml), // 取り直し(GET)
      () => html(listHtml),
    ]);
    expect((await ok.client.searchFirst("13")).total).toBe(26906);
    const ng = setup([
      () => html(searchPageHtml),
      () => html(searchPageHtml),
      () => html(searchPageHtml),
      () => html(searchPageHtml),
    ]);
    const err = await ng.client.searchFirst("13").catch((e) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect(err.kind).toBe("layout");
  });

  it("★取り直しを含め、どの呼び出しの前にも夜間かを確かめ、外なら先方に頼まず止める(@codex #477)", async () => {
    const calls: string[] = [];
    let allowed = 2;
    const client = createRegistryClient({
      fetchImpl: (async (url: string | URL) => {
        calls.push(String(url));
        // 2回目(検索)はセッション切れで検索画面に戻される=取り直しが走る
        return html(calls.length === 2 ? searchPageHtml : searchPageHtml);
      }) as typeof fetch,
      sleep: async () => {},
      now: () => 0,
      decode: (buf) => new TextDecoder("utf-8").decode(buf),
      allowRequest: () => allowed-- > 0,
    });
    const err = await client.searchFirst("13").catch((e) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect(err.kind).toBe("outside_window");
    expect(calls).toHaveLength(2); // 取り直しの GET は頼んでいない
  });

  it("★見出しのあと本文が止まっても、時間切れで止める(本文を読み終えるまで時間を測る・@codex #477)", async () => {
    let n = 0;
    const client = createRegistryClient({
      fetchImpl: (async (_url: string | URL, init?: RequestInit) => {
        n++;
        if (n === 1) return html(searchPageHtml);
        const signal = init!.signal!;
        return {
          status: 200,
          headers: new Headers(),
          arrayBuffer: () =>
            new Promise<ArrayBuffer>((_, reject) =>
              signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))),
            ),
        } as unknown as Response;
      }) as typeof fetch,
      sleep: async () => {},
      now: () => 0,
      timeoutMs: 20,
      decode: (buf) => new TextDecoder("utf-8").decode(buf),
    });
    expect(await client.searchFirst("13").catch((e) => e.kind)).toBe("timeout");
  });

  it("★1回の予算(回数・時間)は、セッションの取り直しを含むどの呼び出しの前にも確かめる(100回を1回も超えない・@codex #477)", async () => {
    const calls: string[] = [];
    let clock = 0;
    const mk = (budget: { maxRequests: number; deadlineMs: number }) =>
      createRegistryClient({
        fetchImpl: (async (url: string | URL) => {
          calls.push(String(url));
          return html(searchPageHtml); // 検索の返事も検索画面=セッション切れ扱い→取り直しが走る
        }) as typeof fetch,
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
        decode: (buf) => new TextDecoder("utf-8").decode(buf),
        budget,
      });
    // 回数: 予算2回=セッション GET + 検索で使い切る → 取り直しの GET は頼まず budget で止まる
    const a = mk({ maxRequests: 2, deadlineMs: 10 ** 9 });
    expect(await a.searchFirst("13").catch((e) => e.kind)).toBe("budget");
    expect(calls).toHaveLength(2);
    expect(a.requestCount).toBe(2);
    // 時間: 4秒の待ちを含めて期限を過ぎたら頼まない
    calls.length = 0;
    clock = 0;
    const b = mk({ maxRequests: 100, deadlineMs: 5000 });
    expect(await b.searchFirst("13").catch((e) => e.kind)).toBe("budget");
    expect(calls).toHaveLength(2); // 1回目(0秒)・2回目(4秒)まで。3回目は8秒=期限5秒を越える
  });

  it("既定の読み方は Shift_JIS(先方の文字コード)", () => {
    expect(new TextDecoder("shift_jis").decode(new Uint8Array([0x82, 0xa0]))).toBe("あ");
  });
});
