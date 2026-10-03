/**
 * 画面側から Service Worker(`public/sw.js`)を使う窓口(通知 段階1・設計書 §4.1・§4.5)。
 *
 * - OS の通知は `new Notification()` ではなく Service Worker の `showNotification()` で出す
 *   (Android の Chrome・iPhone のホーム画面アプリは後者が前提)。
 * - 表示・後片付けは Service Worker の順番待ちに頼み、返事は最大3秒待つ。
 * - 後片付け(`cleanupNotifications`)は共用 PC で前の人の通知を次の人に見せないためのもの。
 *   **通知を閉じられたと確認できたときだけ true**。初めから OS の通知を出せない環境
 *   (Service Worker・Notification が無い、登録が無い)は「片付け済み」とみなして true。
 */
import { applyCleanup, normalizeCleanupState } from "./cleanup-state";

export const SW_URL = "/sw.js";
export const SW_REPLY_TIMEOUT_MS = 3000;
const DB_NAME = "pm-notify";
const STORE = "state";
const STATE_KEY = "main";
const APP_TAG = "pm";
/** 端末の結び付け(段階4a)。Service Worker(public/sw.js)の BINDING_KEY と同じ。 */
export const BINDING_KEY = "binding";

export type NotificationSupport = "unsupported" | "default" | "granted" | "denied";

function hasServiceWorker(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator;
}

function hasNotification(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function notificationSupport(): NotificationSupport {
  if (!hasServiceWorker() || !hasNotification()) return "unsupported";
  return Notification.permission as NotificationSupport;
}

export async function registerNotificationWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!hasServiceWorker()) return null;
  try {
    return await navigator.serviceWorker.register(SW_URL, { scope: "/" });
  } catch {
    return null;
  }
}

export async function requestNotificationPermission(): Promise<NotificationSupport> {
  if (notificationSupport() === "unsupported") return "unsupported";
  try {
    const result = await Notification.requestPermission();
    if (result === "granted") await registerNotificationWorker();
    return result as NotificationSupport;
  } catch {
    return notificationSupport();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(null);
      },
    );
  });
}

type SwReply = { ok?: boolean; gen?: number; version?: number; push?: boolean; stale?: boolean };

async function ask(reg: ServiceWorkerRegistration, msg: Record<string, unknown>): Promise<SwReply | null> {
  const worker = reg.active ?? reg.waiting ?? reg.installing;
  if (!worker) return null;
  const reply = new Promise<SwReply>((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => resolve((e.data ?? {}) as SwReply);
    worker.postMessage(msg, [ch.port2]);
  });
  return withTimeout(reply, SW_REPLY_TIMEOUT_MS);
}

async function readyRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!hasServiceWorker()) return null;
  return withTimeout(navigator.serviceWorker.ready, SW_REPLY_TIMEOUT_MS);
}

/** 今の「切り替えの世代」。取れなければ null(その間は OS の通知を出さない)。 */
export async function fetchSwGeneration(): Promise<number | null> {
  const reg = await readyRegistration();
  if (!reg) return null;
  const res = await ask(reg, { type: "version" });
  return res?.ok && typeof res.gen === "number" ? res.gen : null;
}

/**
 * OS の通知を出す。許可が無い・Service Worker が無い・世代が取れないときは何もしない
 * (画面内のお知らせだけになる)。⚠本文は種類と定型文だけ(PII を入れない)。
 */
export async function showOsNotification(input: {
  gen: number;
  title: string;
  body: string;
  tag: string;
  url?: string;
}): Promise<boolean> {
  if (notificationSupport() !== "granted") return false;
  const reg = await readyRegistration();
  if (!reg) return false;
  const res = await ask(reg, { type: "show", ...input });
  return !!res?.ok;
}

/**
 * 取り下げた知らせの OS の通知を閉じる(同じ tag・同じ世代のもの)。世代が今と違う依頼
 * (前の人のまま開いていたタブ)は Service Worker が断る。Service Worker が無い・登録が無いときは
 * 初めから出ていないので何もしない。表示の依頼と同じ順番待ちで処理される。
 */
export async function closeOsNotification(tag: string, gen: number): Promise<boolean> {
  if (!hasServiceWorker() || !hasNotification()) return false;
  let reg: ServiceWorkerRegistration | undefined;
  try {
    reg = await navigator.serviceWorker.getRegistration("/");
  } catch {
    return false;
  }
  if (!reg) return false;
  const res = await ask(reg, { type: "close", tag, gen });
  return !!res?.ok;
}

// ---- 画面からの直接の後片付け(Service Worker の返事が無いとき) ----

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function applyCleanupDirect(cleanupId: string): Promise<number> {
  const db = await openDb();
  try {
    return await new Promise<number>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      let gen = 0;
      const req = store.get(STATE_KEY);
      req.onsuccess = () => {
        const { state, changed } = applyCleanup(normalizeCleanupState(req.result), cleanupId, Date.now());
        if (changed) {
          store.put(state, STATE_KEY);
          // Service Worker と同じく、結び付け(段階4a)も消す。
          store.delete(BINDING_KEY);
        }
        gen = state.gen;
      };
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve(gen);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

function newCleanupId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * 共用 PC の後片付け。ログアウト・ログイン画面を開いたとき・ログインの送信前に呼ぶ。
 * true = 本システムの OS 通知が残っていないと確認できた。
 */
export async function cleanupNotifications(): Promise<boolean> {
  if (!hasServiceWorker() || !hasNotification()) return true;
  let reg: ServiceWorkerRegistration | undefined;
  try {
    reg = await navigator.serviceWorker.getRegistration("/");
  } catch {
    return false;
  }
  if (!reg) return true;
  const cleanupId = newCleanupId();
  const res = await ask(reg, { type: "cleanup", cleanupId });
  if (res?.ok) return true;
  // 返事が失敗・時間切れ → 同じ cleanupId で、先に世代を上げてから直接閉じる。
  try {
    const gen = await applyCleanupDirect(cleanupId);
    const list = await reg.getNotifications();
    for (const n of list) {
      const data = n.data as { app?: string; gen?: number } | null;
      if (data?.app === APP_TAG && !(typeof data.gen === "number" && data.gen >= gen)) n.close();
    }
    return true;
  } catch {
    return false;
  }
}

// ---- Web プッシュ(段階4a・設計書 §7.1・§7.5) ----

export type DeviceScope = "shared" | "personal";
export type PushSetupResult =
  | { ok: true; deviceScope: DeviceScope }
  | { ok: false; reason: "unsupported" | "not_configured" | "reload_required" | "denied" | "failed" };

function hasPushManager(): boolean {
  return typeof window !== "undefined" && "PushManager" in window;
}

/**
 * push を受けられる Service Worker(版2以上)が動いているか確かめて、その登録を返す。
 * 古い版(段階1)が動いていれば `update()` で新しい版を取りに行き、入れ替わってから確かめ直す
 * (古い版のまま購読すると、届いた通知が黙って捨てられるため・設計書 §7.1)。
 */
export async function pushReadyRegistration(): Promise<ServiceWorkerRegistration | "reload_required" | null> {
  if (!hasServiceWorker() || !hasNotification() || !hasPushManager()) return null;
  const reg = (await registerNotificationWorker()) ?? (await readyRegistration());
  if (!reg) return null;
  const supportsPush = async () => {
    const r = await readyRegistration();
    if (!r) return false;
    const res = await ask(r, { type: "version" });
    return !!res?.ok && res.push === true;
  };
  if (await supportsPush()) return reg;
  try {
    await reg.update();
  } catch {
    /* 下で確かめ直す */
  }
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 300));
    if (await supportsPush()) return reg;
  }
  return "reload_required";
}

function base64UrlToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded = base64Url + "=".repeat((4 - (base64Url.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function putSubscription(
  sub: PushSubscription,
  deviceScope?: DeviceScope,
): Promise<{ status: number; body: { bindingId?: string; deviceScope?: DeviceScope; error?: { code?: string } } | null }> {
  const json = sub.toJSON();
  const res = await fetch("/api/push/subscription", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, ...(deviceScope ? { deviceScope } : {}) }),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

function writeBindingDirect(binding: string, gen: number): Promise<boolean> {
  return openDb().then(
    (db) =>
      new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        let ok = false;
        const req = store.get(STATE_KEY);
        req.onsuccess = () => {
          if (normalizeCleanupState(req.result).gen !== gen) return;
          store.put(binding, BINDING_KEY);
          ok = true;
        };
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => {
          db.close();
          resolve(ok);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      }),
  );
}

/**
 * 付け替えに成功した結び付けを Service Worker に保存する(設計書 §7.5)。`gen` は画面がこのタブを
 * 開いたときの「切り替えの世代」。世代が変わっていれば(前の人のまま開いていたタブ)保存しない。
 */
async function storeBinding(reg: ServiceWorkerRegistration, binding: string, gen: number): Promise<boolean> {
  const res = await ask(reg, { type: "binding", binding, gen });
  if (res?.ok) return true;
  if (res?.stale) return false;
  try {
    return await writeBindingDirect(binding.toLowerCase(), gen);
  } catch {
    return false;
  }
}

/**
 * この端末を登録(または付け替え)して、画面を閉じていても届くようにする。
 * `deviceScope` は今の利用者がこの操作で選んだときだけ渡す(ログイン後の自動の付け替えでは渡さない)。
 * `subscribeIfMissing` = 購読が無ければ作る(「通知を許可する」を押したとき)。false なら、既にある購読の
 * 付け替えだけを行う(ログイン後・期限切れからの戻り)。
 */
export async function setupPushDevice(opts: {
  gen: number;
  deviceScope?: DeviceScope;
  subscribeIfMissing: boolean;
  /**
   * 後片付け(ログアウト・ほかのタブのログイン画面)が起きたか。登録の直前と、結び付けを保存する直前に
   * 確かめ、起きていれば何もしない(ログアウトの解除のあとに登録し直して、配信を再開させないため)。
   */
  isCancelled?: () => boolean;
}): Promise<PushSetupResult> {
  if (notificationSupport() === "unsupported" || !hasPushManager()) return { ok: false, reason: "unsupported" };
  if (Notification.permission !== "granted") return { ok: false, reason: "denied" };
  let config: { enabled?: boolean; publicKey?: string | null } | null = null;
  try {
    const res = await fetch("/api/push/config", { cache: "no-store", credentials: "same-origin" });
    config = res.ok ? await res.json() : null;
  } catch {
    config = null;
  }
  if (!config?.enabled || !config.publicKey) return { ok: false, reason: "not_configured" };
  const reg = await pushReadyRegistration();
  if (reg === "reload_required") return { ok: false, reason: "reload_required" };
  if (!reg) return { ok: false, reason: "unsupported" };
  try {
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      if (!opts.subscribeIfMissing) return { ok: false, reason: "failed" };
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToUint8Array(config.publicKey) });
    }
    if (opts.isCancelled?.()) return { ok: false, reason: "failed" };
    let r = await putSubscription(sub, opts.deviceScope);
    if (r.status === 409 && r.body?.error?.code === "endpoint_gone") {
      // 中継サービスが無効と返した宛先は捨てて、新しい宛先で登録し直す(設計書 §7.5)。
      await sub.unsubscribe().catch(() => false);
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToUint8Array(config.publicKey) });
      r = await putSubscription(sub, opts.deviceScope);
    }
    if (r.status === 501) return { ok: false, reason: "not_configured" };
    if (r.status !== 200 || !r.body?.bindingId || !r.body.deviceScope) return { ok: false, reason: "failed" };
    if (opts.isCancelled?.()) return { ok: false, reason: "failed" };
    const stored = await storeBinding(reg, r.body.bindingId, opts.gen);
    return stored ? { ok: true, deviceScope: r.body.deviceScope } : { ok: false, reason: "failed" };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

/** shared の端末の期限を延ばす(自動ログオフの延長と同じ5分ごと)。期限切れなら付け替え直す。 */
export async function extendPushDevice(gen: number, isCancelled?: () => boolean): Promise<void> {
  if (notificationSupport() !== "granted" || !hasPushManager() || !hasServiceWorker()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/");
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    const res = await fetch("/api/push/subscription/extend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    const body = (await res.json().catch(() => null)) as { active?: boolean } | null;
    if (res.ok && body?.active === false && !isCancelled?.()) await setupPushDevice({ gen, subscribeIfMissing: false, isCancelled });
  } catch {
    /* 次の機会に */
  }
}

/**
 * ログアウトでの解除(設計書 §7.5 の 3)。サーバー側で無効にする(以後この端末には送らない)。
 * ⚠購読そのもの(pushManager)は捨てない。サーバーで無効にした時点で送られず、結び付けも後片付けで
 * 消えるので、届いても中身は出ない(§7.5 の 1・2 が主・これは補助)。捨てると、次に同じ人が
 * ログインしたとき「この端末は自分専用」の選択が新しい宛先に引き継がれず、毎回選び直しになるため。
 * 失敗してもログアウトは止めない。
 */
export async function unregisterPushDevice(): Promise<void> {
  if (!hasServiceWorker() || !hasPushManager()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/");
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    await withTimeout(
      fetch("/api/push/subscription", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }),
      SW_REPLY_TIMEOUT_MS,
    );
  } catch {
    /* ログアウトは続ける */
  }
}
