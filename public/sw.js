/*
 * 物件管理システムの Service Worker(通知 段階1・設計書 §4.5)。
 *
 * - 通知の表示と、押したときに画面を開くことだけを持つ。
 *   ⚠ページの読み込みは横取りしない(fetch を扱わない・キャッシュしない)。
 *   サーバーからの受信(push)は段階4で足す。
 * - 表示の依頼と後片付け(共用 PC で人が替わるとき)を**1本の順番待ち**で1件ずつ処理する。
 *   1件が失敗しても列は止めない。
 * - 「切り替えの世代」を IndexedDB に持つ。規則は src/lib/notifications/cleanup-state.ts と同じ
 *   (処理済みの cleanupId の一覧・最大100件・1日)。変えるときは両方を揃える。
 */
const SW_VERSION = 1;
const DB_NAME = "pm-notify";
const STORE = "state";
const STATE_KEY = "main";
const CLEANUP_IDS_MAX = 100;
const CLEANUP_IDS_TTL_MS = 24 * 60 * 60 * 1000;
const APP_TAG = "pm";

let queue = Promise.resolve();
function enqueue(task) {
  const p = queue.then(task);
  // 失敗を受け止めてから次をつなぐ(列を止めない)。
  queue = p.catch(() => {});
  return p;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function normalize(v) {
  const gen = v && typeof v.gen === "number" && Number.isFinite(v.gen) ? v.gen : 0;
  const ids = v && Array.isArray(v.cleanupIds)
    ? v.cleanupIds.filter((x) => x && typeof x.id === "string" && typeof x.at === "number")
    : [];
  return { gen, cleanupIds: ids };
}

async function readState() {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(STATE_KEY);
      req.onsuccess = () => resolve(normalize(req.result));
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

// 1つの読み書きトランザクションで「処理済みなら何もしない/違えば世代を上げて記録」。
async function applyCleanup(cleanupId) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      let result = null;
      const req = store.get(STATE_KEY);
      req.onsuccess = () => {
        const state = normalize(req.result);
        if (state.cleanupIds.some((x) => x.id === cleanupId)) {
          result = { changed: false, gen: state.gen };
          return;
        }
        const now = Date.now();
        const kept = state.cleanupIds.filter((x) => now - x.at < CLEANUP_IDS_TTL_MS);
        const next = {
          gen: state.gen + 1,
          cleanupIds: kept.concat([{ id: cleanupId, at: now }]).slice(-CLEANUP_IDS_MAX),
        };
        store.put(next, STATE_KEY);
        result = { changed: true, gen: next.gen };
      };
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

function isOurs(n) {
  return n && n.data && n.data.app === APP_TAG;
}

async function closeOlderThan(gen) {
  const list = await self.registration.getNotifications();
  for (const n of list) {
    if (isOurs(n) && !(typeof n.data.gen === "number" && n.data.gen >= gen)) n.close();
  }
}

function safePath(url) {
  if (typeof url !== "string" || !url.startsWith("/") || url.startsWith("//")) return "/home";
  return url;
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  const port = event.ports && event.ports[0];
  const reply = (msg) => {
    if (port) port.postMessage(msg);
  };

  if (data.type === "version") {
    event.waitUntil(
      enqueue(async () => {
        const state = await readState();
        reply({ ok: true, version: SW_VERSION, push: false, gen: state.gen });
      }).catch(() => reply({ ok: false })),
    );
    return;
  }

  if (data.type === "show") {
    event.waitUntil(
      enqueue(async () => {
        const state = await readState();
        // 世代が今と違う(前の人のまま開いていたタブ)の依頼は出さない。
        if (data.gen !== state.gen) {
          reply({ ok: false, stale: true });
          return;
        }
        const tag = typeof data.tag === "string" ? data.tag : undefined;
        await self.registration.showNotification(String(data.title || ""), {
          body: String(data.body || ""),
          tag,
          data: { app: APP_TAG, gen: state.gen, url: safePath(data.url) },
        });
        // 表示のあとで世代を読み直し、変わっていれば(追い越された後片付け)すぐ閉じる。
        const after = await readState();
        if (after.gen !== state.gen) {
          const list = await self.registration.getNotifications(tag ? { tag } : undefined);
          for (const n of list) {
            if (isOurs(n) && n.data.gen === state.gen) n.close();
          }
          reply({ ok: false, stale: true });
          return;
        }
        reply({ ok: true });
      }).catch(() => reply({ ok: false })),
    );
    return;
  }

  // 取り下げた知らせ(例: 予告のあとに操作があって延長された)の OS の通知を閉じる。
  // 表示の依頼と同じ順番待ちに入れ、先に出した依頼の後で閉じる(@codex #462)。
  if (data.type === "close") {
    event.waitUntil(
      enqueue(async () => {
        if (typeof data.tag !== "string" || !data.tag) {
          reply({ ok: false });
          return;
        }
        const list = await self.registration.getNotifications({ tag: data.tag });
        for (const n of list) {
          if (isOurs(n)) n.close();
        }
        reply({ ok: true });
      }).catch(() => reply({ ok: false })),
    );
    return;
  }

  if (data.type === "cleanup") {
    event.waitUntil(
      enqueue(async () => {
        if (typeof data.cleanupId !== "string" || !data.cleanupId) {
          reply({ ok: false });
          return;
        }
        const result = await applyCleanup(data.cleanupId);
        if (result.changed) {
          await closeOlderThan(result.gen);
          const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
          for (const c of clients) c.postMessage({ type: "pm-switched", gen: result.gen });
        }
        reply({ ok: true, gen: result.gen });
      }).catch(() => reply({ ok: false })),
    );
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const path = safePath(data.url);
  event.waitUntil(
    (async () => {
      const target = new URL(path, self.location.origin).href;
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of clients) {
        if (c.url === target && "focus" in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
      return undefined;
    })(),
  );
});
