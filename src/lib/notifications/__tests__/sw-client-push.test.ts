/**
 * 画面側の端末登録(段階4a・設計書 §7.5)。ブラウザの部品(Service Worker・PushManager・fetch)は
 * 最小の作り物で置き換え、登録の順番・取り消し・鍵の入れ替わりを確かめる(@codex #471 P2 ×3)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupPushDevice, subscriptionKeyMatches, unregisterPushDevice } from "../sw-client";

const KEY_A = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
const KEY_B = "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM";
const BIND = "11111111-1111-4111-8111-111111111111";

function b64uToBytes(s: string): Uint8Array {
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
}

type Call = { method: string; url: string; body: Record<string, unknown> | null };

function fakeSub(endpoint: string, key: string | null) {
  return {
    endpoint,
    options: { applicationServerKey: key ? b64uToBytes(key).buffer : null },
    toJSON: () => ({ endpoint, keys: { p256dh: "pk", auth: "au" } }),
    unsubscribe: vi.fn(async () => true),
  };
}

function install(opts: { subKey?: string | null; configKey?: string; putDelay?: (n: number) => Promise<void>; locks?: boolean } = {}) {
  const calls: Call[] = [];
  const swMessages: Record<string, unknown>[] = [];
  let current: ReturnType<typeof fakeSub> | null = opts.subKey === undefined ? fakeSub("https://fcm.googleapis.com/fcm/send/old", KEY_A) : opts.subKey === null ? null : fakeSub("https://fcm.googleapis.com/fcm/send/old", opts.subKey);
  const subscribe = vi.fn(async () => {
    current = fakeSub("https://fcm.googleapis.com/fcm/send/new", opts.configKey ?? KEY_A);
    return current;
  });
  const worker = {
    postMessage: (msg: Record<string, unknown>, ports: MessagePort[]) => {
      swMessages.push(msg);
      const reply = msg.type === "version" ? { ok: true, version: 2, push: true, gen: 0 } : { ok: true };
      ports[0].postMessage(reply);
    },
  };
  const reg = {
    active: worker,
    pushManager: { getSubscription: async () => current, subscribe },
    update: async () => {},
  };
  let puts = 0;
  vi.stubGlobal("window", { Notification: {}, PushManager: {} });
  vi.stubGlobal("Notification", { permission: "granted" });
  const nav: Record<string, unknown> = {
    serviceWorker: { register: async () => reg, ready: Promise.resolve(reg), getRegistration: async () => reg },
  };
  if (opts.locks) {
    // 名前ごとの FIFO(Web Locks の最小の作り物)。
    let chain: Promise<unknown> = Promise.resolve();
    nav.locks = {
      request: (_name: string, a: unknown, b?: unknown) => {
        const fn = (typeof a === "function" ? a : b) as () => Promise<unknown>;
        const run = chain.then(() => fn());
        chain = run.catch(() => undefined);
        return run;
      },
    };
  }
  vi.stubGlobal("navigator", nav);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      const call: Call = { method, url, body };
      if (url === "/api/push/config") return new Response(JSON.stringify({ enabled: true, publicKey: opts.configKey ?? KEY_A }));
      if (method === "PUT") {
        const n = ++puts;
        calls.push({ ...call, method: "PUT:start" });
        await opts.putDelay?.(n);
        calls.push(call);
        return new Response(JSON.stringify({ bindingId: BIND, deviceScope: body?.deviceScope ?? "shared" }));
      }
      calls.push(call);
      return new Response(JSON.stringify({ ok: true }));
    }),
  );
  return { calls, swMessages, subscribe, current: () => current };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("購読を作ったときの鍵の比べ方", () => {
  it("同じ鍵なら true・違う鍵なら false・読めないときは true", () => {
    expect(subscriptionKeyMatches(fakeSub("e", KEY_A) as unknown as PushSubscription, KEY_A)).toBe(true);
    expect(subscriptionKeyMatches(fakeSub("e", KEY_B) as unknown as PushSubscription, KEY_A)).toBe(false);
    expect(subscriptionKeyMatches(fakeSub("e", null) as unknown as PushSubscription, KEY_A)).toBe(true);
  });
});

describe("端末の登録(画面側)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("登録の最中に後片付けが起きたら、その結び付けのときだけ取り消す・結び付けは保存しない", async () => {
    const env = install();
    let cancelled = false;
    const r = await setupPushDevice({
      gen: 0,
      subscribeIfMissing: true,
      isCancelled: () => {
        // 1回目(登録の前)は未だ・2回目(登録のあと)で起きていたことにする
        const v = cancelled;
        cancelled = true;
        return v;
      },
    });
    expect(r).toEqual({ ok: false, reason: "failed" });
    const del = env.calls.find((c) => c.method === "DELETE");
    expect(del?.body).toEqual({ endpoint: "https://fcm.googleapis.com/fcm/send/old", bindingId: BIND, reason: "cancelled" });
    expect(env.swMessages.some((m) => m.type === "binding")).toBe(false);
  });

  it("鍵が入れ替わっていたら、古い宛先を無効にして購読を作り直してから登録する", async () => {
    const env = install({ subKey: KEY_B, configKey: KEY_A });
    const old = env.current()!;
    const r = await setupPushDevice({ gen: 0, subscribeIfMissing: false });
    expect(r).toEqual({ ok: true, deviceScope: "shared" });
    expect(old.unsubscribe).toHaveBeenCalled();
    expect(env.subscribe).toHaveBeenCalledTimes(1);
    const methods = env.calls.filter((c) => c.method !== "PUT:start").map((c) => `${c.method}:${String(c.body?.endpoint ?? "")}:${String(c.body?.reason ?? "")}`);
    expect(methods).toEqual(["DELETE:https://fcm.googleapis.com/fcm/send/old:key_changed", "PUT:https://fcm.googleapis.com/fcm/send/new:"]);
  });

  it("鍵が同じなら作り直さない", async () => {
    const env = install({ subKey: KEY_A, configKey: KEY_A });
    await setupPushDevice({ gen: 0, subscribeIfMissing: false });
    expect(env.subscribe).not.toHaveBeenCalled();
    expect(env.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  for (const locks of [true, false]) {
    it(`「自分専用」を素早く切り替えても、押した順に1本ずつ保存する(${locks ? "Web Locks" : "このタブの中の順番待ち"})`, async () => {
      let release!: () => void;
      const first = new Promise<void>((r) => (release = r));
      const env = install({ locks, putDelay: (n) => (n === 1 ? first : Promise.resolve()) });
      const p1 = setupPushDevice({ gen: 0, deviceScope: "personal", subscribeIfMissing: true });
      const p2 = setupPushDevice({ gen: 0, deviceScope: "shared", subscribeIfMissing: true });
      await new Promise((r) => setTimeout(r, 20));
      // 1本目の保存が終わるまで、2本目は始まらない
      expect(env.calls.filter((c) => c.method === "PUT:start")).toHaveLength(1);
      release();
      await Promise.all([p1, p2]);
      const done = env.calls.filter((c) => c.method === "PUT").map((c) => c.body?.deviceScope);
      expect(done).toEqual(["personal", "shared"]);
    });
  }

  it("ログアウトの解除は、走っている登録が終わってから行う(登録があとから届いて解除を上書きしない)", async () => {
    let release!: () => void;
    const first = new Promise<void>((r) => (release = r));
    const env = install({ locks: true, putDelay: () => first });
    const setup = setupPushDevice({ gen: 0, subscribeIfMissing: true });
    await new Promise((r) => setTimeout(r, 20));
    const un = unregisterPushDevice();
    await new Promise((r) => setTimeout(r, 20));
    expect(env.calls.some((c) => c.method === "DELETE")).toBe(false);
    release();
    await Promise.all([setup, un]);
    const order = env.calls.filter((c) => c.method === "PUT" || c.method === "DELETE").map((c) => c.method);
    expect(order).toEqual(["PUT", "DELETE"]);
  });
});
