import { LayoutChanged, parseDetail, parseListPage, type Detail, type ListPage } from "./parse";

/**
 * 国交省の宅建業者検索への取得(計画 G1〜G4)。
 * - 同時に1本だけ(内部の待ち行列)・前の呼び出しの開始から 4 秒以上あける。
 * - 200 以外・時間切れ・つながらない → すぐ `FetchError` で止める(取り直さない)。
 * - 検索画面に戻された(セッション切れ)ときだけ、1回だけセッションを取り直す。
 *   それでも読めなければ `layout` で止める(推測で読まない)。
 * - 名乗りは正直に書く。
 */

const BASE = "https://etsuran2.mlit.go.jp/TAKKEN/";
export const REGISTRY_USER_AGENT = "property-management agent-registry (low-rate; ligarejapan.com)";
export const MIN_INTERVAL_MS = 4000;
const TIMEOUT_MS = 30_000;

/** outside_window=頼んでよい時間の外(先方の失敗ではない=失敗に数えない)。 */
export type FetchFail = "http_429" | "http_5xx" | "http_other" | "timeout" | "network" | "layout" | "outside_window";

export class FetchError extends Error {
  constructor(public readonly kind: FetchFail) {
    super(`取得に失敗しました: ${kind}`);
    this.name = "FetchError";
  }
}

export interface RegistryClient {
  searchFirst(authority: string): Promise<ListPage>;
  selectPage(authority: string, page: number): Promise<ListPage>;
  detail(licenseKey: string): Promise<Detail>;
  readonly requestCount: number;
}

export interface RegistryClientOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  minIntervalMs?: number;
  timeoutMs?: number;
  /** 応答の読み方(既定 Shift_JIS)。テストで差し替える。 */
  decode?: (buf: ArrayBuffer) => string;
  /**
   * 頼んでよいか(夜間の内か)。セッションの取り直しを含む**すべての呼び出しの直前**(4秒待ったあと)に確かめ、
   * false なら頼まずに `outside_window` で止める(@codex #477)。
   */
  allowRequest?: () => boolean;
}

/** 検索の基本の項目(先方の画面のフォームと同じ名前)。値は ASCII だけ。 */
function baseForm(authority: string): Record<string, string> {
  return {
    CMD: "",
    caller: "TK",
    rdoSelect: "1",
    rdoSelectJoken: "1",
    licenseNoKbn: authority,
    licenseNoFrom: "",
    licenseNoTo: "",
    choice: "1",
    kenCode: "",
    sortValue: "1",
    rdoSelectSort: "1",
    dispCount: "50",
    dispPage: "1",
    comNameKanaOnly: "",
    comNameKanjiOnly: "",
  };
}

function hiddenInputs(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<input\b[^>]*type="hidden"[^>]*>/g)) {
    const name = m[0].match(/\bname="([^"]*)"/)?.[1];
    if (!name) continue;
    const value = m[0].match(/\bvalue="([^"]*)"/)?.[1] ?? "";
    out[name] = value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  }
  return out;
}

/** 検索画面に戻された(=セッション切れ)か。一覧にも詳細にもある印が無いときだけ。 */
function isSearchPage(html: string): boolean {
  return /id="tkModel"/.test(html) && !/検索結果：/.test(html) && !/免許証番号<\/th>/.test(html);
}

function encodeForm(fields: Record<string, string>): string {
  for (const v of Object.values(fields)) {
    // 先方は cp932。ASCII 以外を送ると文字化けして別の条件になりうる=送らずに止める。
    if (/[^\x20-\x7e]/.test(v)) throw new FetchError("layout");
  }
  return new URLSearchParams(fields).toString();
}

/** セッション切れ(検索画面に戻された)の印。1回だけ取り直す合図に使う。 */
class SessionExpired extends Error {}

export function createRegistryClient(opts: RegistryClientOptions = {}): RegistryClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const minInterval = opts.minIntervalMs ?? MIN_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const decode = opts.decode ?? ((buf: ArrayBuffer) => new TextDecoder("shift_jis").decode(buf));
  const allowRequest = opts.allowRequest ?? (() => true);

  const cookies = new Map<string, string>();
  let sessionReady = false;
  let lastStart: number | null = null;
  let count = 0;
  /** 直前の一覧の隠し項目(ページ送りで送り返す)と、そのときの件数・ページ数。 */
  let lastList: { authority: string; hidden: Record<string, string>; total: number; pages: number } | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  async function request(path: string, form?: Record<string, string>): Promise<string> {
    if (lastStart !== null) {
      const wait = lastStart + minInterval - now();
      if (wait > 0) await sleep(wait);
    }
    if (!allowRequest()) throw new FetchError("outside_window");
    lastStart = now();
    count++;
    const headers: Record<string, string> = { "user-agent": REGISTRY_USER_AGENT };
    if (cookies.size > 0) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    let body: string | undefined;
    if (form) {
      body = encodeForm(form);
      headers["content-type"] = "application/x-www-form-urlencoded";
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(BASE + path, { method: form ? "POST" : "GET", headers, body, signal: ac.signal });
    } catch (e) {
      throw new FetchError((e as { name?: string })?.name === "AbortError" ? "timeout" : "network");
    } finally {
      clearTimeout(timer);
    }
    const setCookies =
      typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : [res.headers.get("set-cookie")].filter((v): v is string => !!v);
    for (const sc of setCookies) {
      const pair = sc.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    if (res.status === 429) throw new FetchError("http_429");
    if (res.status >= 500) throw new FetchError("http_5xx");
    if (res.status !== 200) throw new FetchError("http_other");
    return decode(await res.arrayBuffer());
  }

  async function ensureSession(): Promise<void> {
    if (sessionReady) return;
    await request("takkenKensaku.do?outPutKbn=1");
    sessionReady = true;
    lastList = null;
  }

  /** 読み取りに失敗した画面が検索画面ならセッション切れ、それ以外は先方の画面の変化。 */
  function readOrExpire<T>(html: string, read: (h: string) => T): T {
    try {
      return read(html);
    } catch (e) {
      if (e instanceof LayoutChanged && isSearchPage(html)) throw new SessionExpired();
      throw e;
    }
  }

  function readList(html: string, authority: string): ListPage {
    const page = readOrExpire(html, parseListPage);
    lastList = { authority, hidden: hiddenInputs(html), total: page.total, pages: page.pages };
    return page;
  }

  async function search(authority: string): Promise<ListPage> {
    const html = await request("takkenKensaku.do", { ...baseForm(authority), CMD: "search" });
    return readList(html, authority);
  }

  async function selectPage(authority: string, page: number): Promise<ListPage> {
    if (!lastList || lastList.authority !== authority) await search(authority);
    // 止まっている間に件数が減り、続きのページがもう無い=頼まずに空の結果を返す(進め方が一覧の終わりとして扱う)。
    if (lastList && page > lastList.pages) return { total: lastList.total, pages: lastList.pages, page, rows: [] };
    const html = await request("takkenKensaku.do", {
      ...baseForm(authority),
      ...(lastList?.hidden ?? {}),
      CMD: "selectPage",
      pageListNo1: String(page),
      pageListNo2: String(page),
    });
    return readList(html, authority);
  }

  async function detail(licenseKey: string): Promise<Detail> {
    const html = await request("tkGaiyo.do", { ...baseForm(licenseKey.slice(0, 2)), sv_licenseNo: licenseKey });
    return readOrExpire(html, (h) => parseDetail(h, licenseKey));
  }

  /** 1回の操作。セッション切れのときだけ1回取り直す。読めない画面は layout で止める。 */
  async function withSession<T>(op: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await ensureSession();
      try {
        return await op();
      } catch (e) {
        if (e instanceof FetchError) throw e;
        if (e instanceof SessionExpired && attempt === 0) {
          sessionReady = false;
          cookies.clear();
          continue;
        }
        if (e instanceof SessionExpired || e instanceof LayoutChanged) throw new FetchError("layout");
        throw e;
      }
    }
  }

  function enqueue<T>(op: () => Promise<T>): Promise<T> {
    const next = queue.then(op, op);
    queue = next.catch(() => undefined);
    return next;
  }

  return {
    searchFirst: (authority) => enqueue(() => withSession(() => search(authority))),
    selectPage: (authority, page) => enqueue(() => withSession(() => selectPage(authority, page))),
    detail: (licenseKey) => enqueue(() => withSession(() => detail(licenseKey))),
    get requestCount() {
      return count;
    },
  };
}
