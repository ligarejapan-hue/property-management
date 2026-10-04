/**
 * Service Worker(public/sw.js)の push 受信と結び付け(段階4a・設計書 §7.5)を、node の上で
 * 本物の sw.js を動かして確かめる(IndexedDB・registration・clients は最小の作り物)。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

const SW_SRC = readFileSync(resolve(__dirname, "../../../../public/sw.js"), "utf-8");
const B1 = "11111111-1111-4111-8111-111111111111";
const B2 = "22222222-2222-4222-8222-222222222222";

// ---- 最小の IndexedDB(1つの store・キーと値) ----
function fakeIndexedDb() {
  const data = new Map<string, unknown>();
  const req = <T>(fn: () => T) => {
    const r: { result?: T; error?: unknown; onsuccess?: () => void; onerror?: () => void } = {};
    queueMicrotask(() => {
      try {
        r.result = fn();
        r.onsuccess?.();
      } catch (e) {
        r.error = e;
        r.onerror?.();
      }
    });
    return r;
  };
  const db = {
    transaction() {
      const tx: { oncomplete?: () => void; onerror?: () => void; objectStore: () => unknown } = {
        objectStore: () => ({
          get: (k: string) => req(() => data.get(k)),
          put: (v: unknown, k: string) => req(() => void data.set(k, v)),
          delete: (k: string) => req(() => void data.delete(k)),
        }),
      };
      // 中の要求が終わってから完了を知らせる
      setTimeout(() => tx.oncomplete?.(), 0);
      return tx;
    },
    close() {},
  };
  return {
    data,
    open() {
      const r: { result?: unknown; onsuccess?: () => void; onupgradeneeded?: () => void; onerror?: () => void } = {};
      queueMicrotask(() => {
        r.result = db;
        r.onsuccess?.();
      });
      return r;
    },
  };
}

type Shown = { title: string; body: string; tag?: string; data: Record<string, unknown>; closed: boolean; close: () => void };

function loadSw() {
  const handlers: Record<string, (e: unknown) => void> = {};
  const shown: Shown[] = [];
  const idb = fakeIndexedDb();
  const self = {
    addEventListener: (t: string, h: (e: unknown) => void) => (handlers[t] = h),
    skipWaiting: () => {},
    clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => null },
    location: { origin: "https://app.example" },
    registration: {
      showNotification: async (title: string, opts: { body: string; tag?: string; data: Record<string, unknown> }) => {
        const n: Shown = { title, body: opts.body, tag: opts.tag, data: opts.data, closed: false, close: () => (n.closed = true) };
        shown.push(n);
      },
      getNotifications: async (filter?: { tag?: string }) =>
        shown.filter((n) => !n.closed && (!filter?.tag || n.tag === filter.tag)),
    },
  };
  vm.runInNewContext(SW_SRC, { self, indexedDB: idb, URL, Promise, setTimeout, queueMicrotask, Date, Number, Array, String, JSON });
  const run = async (type: string, ev: Record<string, unknown>) => {
    const waits: Promise<unknown>[] = [];
    handlers[type]({ ...ev, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  };
  const message = async (data: Record<string, unknown>) => {
    let reply: Record<string, unknown> | null = null;
    await run("message", { data, ports: [{ postMessage: (m: Record<string, unknown>) => (reply = m) }] });
    return reply as unknown as Record<string, unknown>;
  };
  const push = (payload: unknown) =>
    run("push", { data: payload === undefined ? null : { json: () => payload } });
  /** 表示の最中に何かを起こす(順番待ちを通らない画面からの直接の後片付けのまねに使う)。 */
  const onShow = (fn: (title: string, body: string) => void) => {
    const orig = self.registration.showNotification;
    self.registration.showNotification = async (title, opts) => {
      await orig(title, opts);
      fn(title, opts.body);
    };
  };
  return { shown, idb, message, push, run, onShow };
}

let sw: ReturnType<typeof loadSw>;
beforeEach(() => {
  sw = loadSw();
});

describe("Service Worker の push(段階4a)", () => {
  it("版2・push を受けられると答える", async () => {
    expect(await sw.message({ type: "version" })).toMatchObject({ ok: true, version: 2, push: true });
  });
  it("結び付けが無いときは中身を出さない(中身の無い知らせだけ)", async () => {
    await sw.push({ b: B1, title: "次回対応", body: "今日の次回対応が3件あります", url: "/home" });
    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0].body).toBe("新しいお知らせがあります（ログインして確認してください）");
    expect(sw.shown[0].body).not.toContain("3件");
  });
  it("結び付けが一致したときだけ中身を出す・違えば中身なし", async () => {
    expect(await sw.message({ type: "binding", binding: B1, gen: 0 })).toEqual({ ok: true });
    await sw.push({ b: B1, title: "次回対応", body: "今日の次回対応が3件あります", url: "/home", tag: "next-action" });
    await sw.push({ b: B2, title: "次回対応", body: "前の人宛て", url: "/home" });
    expect(sw.shown.map((n) => n.body)).toEqual(["今日の次回対応が3件あります", "新しいお知らせがあります（ログインして確認してください）"]);
    expect(sw.shown[0].data).toMatchObject({ app: "pm", url: "/home", b: B1 });
  });
  it("本文が壊れていても(読めない・無い)中身の無い知らせを出す", async () => {
    await sw.message({ type: "binding", binding: B1, gen: 0 });
    await sw.push(undefined);
    expect(sw.shown[0].body).toBe("新しいお知らせがあります（ログインして確認してください）");
  });
  it("外のURLへは飛ばさない(/home に置き換える)", async () => {
    await sw.message({ type: "binding", binding: B1, gen: 0 });
    await sw.push({ b: B1, title: "t", body: "b", url: "https://evil.example/" });
    expect(sw.shown[0].data.url).toBe("/home");
  });
  it("後片付け(ログアウト・ログイン画面)で結び付けを消す=以後の push は中身なし", async () => {
    await sw.message({ type: "binding", binding: B1, gen: 0 });
    expect(await sw.message({ type: "cleanup", cleanupId: "c1" })).toMatchObject({ ok: true, gen: 1 });
    expect(sw.idb.data.has("binding")).toBe(false);
    await sw.push({ b: B1, title: "次回対応", body: "前の人宛て" });
    expect(sw.shown.at(-1)?.body).toBe("新しいお知らせがあります（ログインして確認してください）");
  });
  it("世代が古いタブ(前の人のまま)からの結び付けの保存は断る", async () => {
    await sw.message({ type: "cleanup", cleanupId: "c1" }); // gen 1
    expect(await sw.message({ type: "binding", binding: B1, gen: 0 })).toEqual({ ok: false, stale: true });
    expect(sw.idb.data.has("binding")).toBe(false);
  });
  it("形の違う結び付けは保存しない", async () => {
    expect(await sw.message({ type: "binding", binding: "not-a-uuid", gen: 0 })).toEqual({ ok: false });
  });
  it("表示と後片付けが重なっても、前の人の中身は通知欄に残らない(同じ順番待ち・世代の古い通知を閉じる)", async () => {
    await sw.message({ type: "binding", binding: B1, gen: 0 });
    const p1 = sw.push({ b: B1, title: "次回対応", body: "前の人宛て", tag: "x" });
    const p2 = sw.message({ type: "cleanup", cleanupId: "c2" });
    await Promise.all([p1, p2]);
    const visible = sw.shown.filter((n) => !n.closed);
    expect(visible.map((n) => n.body)).not.toContain("前の人宛て");
  });
  it("順番待ちを通らない直接の後片付けが表示と重なっても、表示のあとの読み直しで閉じる", async () => {
    await sw.message({ type: "binding", binding: B1, gen: 0 });
    // 表示した直後に、画面からの直接の後片付け(世代を上げて結び付けを消す)が割り込んだことにする
    sw.onShow((_t, body) => {
      if (body === "前の人宛て") {
        sw.idb.data.delete("binding");
        sw.idb.data.set("main", { gen: 1, cleanupIds: [{ id: "direct", at: Date.now() }] });
      }
    });
    await sw.push({ b: B1, title: "次回対応", body: "前の人宛て", tag: "x" });
    expect(sw.shown.find((n) => n.body === "前の人宛て")?.closed).toBe(true);
  });
});
