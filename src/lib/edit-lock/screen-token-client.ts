"use client";

/**
 * 画面の合言葉(仕様 6.1)。**タブ1枚 = 合言葉1つ**。
 *
 * - `sessionStorage["edit-screen-token"]` に置く。読み書きは try/catch(プライベート
 *   モード等で例外になる)。使えない場合はこのページの間だけメモリに持つ
 *   (再読み込みで別の画面扱い=自分の鍵に最大5分締め出される。まれなので許容)。
 * - ⚠**タブの複製で合言葉まで複製される**(@codex R1 P2)。「タブを複製」や
 *   `target=_blank` は元のタブの sessionStorage を写して始まるため、読むだけだと
 *   2枚が同じ保持者になり D6(自分の別タブも待つ)が破れる。開いたときに
 *   `BroadcastChannel("edit-screen")` で「この合言葉を使っているタブは居ますか」と
 *   問い合わせ、**300ms以内に同じ合言葉を名乗る返事があれば作り直す**。
 *   再読み込みは元のタブが消えてから読み込むので返事は来ない=同じ合言葉を保つ。
 *
 * ⚠**このリポジトリは jsdom を使わない方針**(既存の `.test.tsx` は
 *   `renderToStaticMarkup` 一本槍、`@vitest-environment jsdom` は他に無い)。
 *   そのためブラウザ依存(sessionStorage・BroadcastChannel・crypto.randomUUID)は
 *   すべて `ScreenTokenEnv` の向こう側に置き、テストは node のままフェイクの
 *   env を注入して検証する(`setScreenTokenEnvForTest`)。
 */
import { EDIT_SCREEN_HEADER, EDIT_LOCK_HEADER } from "./header-names";

const KEY = "edit-screen-token";
const CHANNEL = "edit-screen";
/** 複製の問い合わせの待ち時間(仕様 6.1)。 */
export const SCREEN_TOKEN_PROBE_MS = 300;

/** `BroadcastChannel` を薄く覆う形。実装(生の Event)をこのモジュールの外に漏らさない。 */
export interface ScreenTokenChannel {
  postMessage(data: unknown): void;
  onMessage(handler: (data: unknown) => void): void;
  close(): void;
}

/** このモジュールがブラウザに求めるものすべて。テストではフェイクに差し替える。 */
export interface ScreenTokenEnv {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  /** BroadcastChannel の無い環境では null を返す。 */
  openChannel(name: string): ScreenTokenChannel | null;
  newId(): string;
}

function fallbackUuid(): string {
  // 古い環境向けの退避。uuid の形は保つ(窓口が uuid を要求するのは lockId だけだが揃える)。
  const h = () => Math.floor(Math.random() * 16).toString(16);
  return `${Array.from({ length: 8 }, h).join("")}-${Array.from({ length: 4 }, h).join("")}-4${Array.from({ length: 3 }, h).join("")}-8${Array.from({ length: 3 }, h).join("")}-${Array.from({ length: 12 }, h).join("")}`;
}

/** 本物のブラウザに向けた既定の env。 */
const browserEnv: ScreenTokenEnv = {
  getItem(key) {
    return sessionStorage.getItem(key);
  },
  setItem(key, value) {
    sessionStorage.setItem(key, value);
  },
  openChannel(name) {
    const Ctor = globalThis.BroadcastChannel;
    if (typeof Ctor !== "function") return null;
    const channel = new Ctor(name);
    return {
      postMessage: (data) => channel.postMessage(data),
      onMessage: (handler) => {
        channel.onmessage = (e: MessageEvent) => handler(e.data);
      },
      close: () => channel.close(),
    };
  },
  newId() {
    try {
      return crypto.randomUUID();
    } catch {
      return fallbackUuid();
    }
  },
};

let currentEnv: ScreenTokenEnv = browserEnv;

/** テスト用。`null` を渡すと本物(browser)の env に戻す。 */
export function setScreenTokenEnvForTest(env: ScreenTokenEnv | null): void {
  currentEnv = env ?? browserEnv;
}

let memoryToken: string | null = null;

function read(): string | null {
  try {
    return currentEnv.getItem(KEY);
  } catch {
    return null;
  }
}

function write(token: string): void {
  try {
    currentEnv.setItem(KEY, token);
  } catch {
    /* 使えない環境ではメモリのみ */
  }
}

/** 今の合言葉を返す(無ければ採番して保存する)。同期。 */
export function getScreenToken(): string {
  const stored = read();
  if (stored) {
    memoryToken = stored;
    return stored;
  }
  if (memoryToken) return memoryToken;
  const token = currentEnv.newId();
  memoryToken = token;
  write(token);
  return token;
}

/**
 * 複製のタブでないことを確かめた合言葉を返す。**編集を押せるようにする前に1回呼ぶ**。
 * `openChannel` が `null` を返す環境では問い合わせを省略する(複製の判別はできない=
 * まれなので許容し、版番号の守りに任せる)。
 */
export async function ensureUniqueScreenToken(): Promise<string> {
  const token = getScreenToken();
  const channel = currentEnv.openChannel(CHANNEL);
  if (!channel) return token;

  const duplicated = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), SCREEN_TOKEN_PROBE_MS);
    channel.onMessage((data) => {
      const msg = data as { type?: string; token?: string } | null;
      if (msg?.type === "i-have" && msg.token === token) {
        clearTimeout(timer);
        resolve(true);
      }
    });
    channel.postMessage({ type: "who-has", token });
  });
  channel.close();

  if (!duplicated) return token;
  const fresh = currentEnv.newId();
  memoryToken = fresh;
  write(fresh);
  return fresh;
}

/** 他のタブからの問い合わせに答え続ける。hook の mount 中だけ張る。 */
export function answerScreenTokenProbes(): () => void {
  const channel = currentEnv.openChannel(CHANNEL);
  if (!channel) return () => {};
  channel.onMessage((data) => {
    const msg = data as { type?: string; token?: string } | null;
    if (msg?.type === "who-has" && msg.token === getScreenToken()) {
      channel.postMessage({ type: "i-have", token: msg.token });
    }
  });
  return () => channel.close();
}

/** テスト用。モジュールが抱えているメモリ上の合言葉を捨てる。 */
export function resetScreenTokenForTest(): void {
  memoryToken = null;
}

/** 保存の入口が付けるヘッダ。⚠**6つの入口すべてがこれを通す**(走査テストで固定)。 */
export function editLockHeaders(lockId?: string | null): Record<string, string> {
  const headers: Record<string, string> = { [EDIT_SCREEN_HEADER]: getScreenToken() };
  if (lockId) headers[EDIT_LOCK_HEADER] = lockId;
  return headers;
}
