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
        if (changed) store.put(state, STATE_KEY);
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
