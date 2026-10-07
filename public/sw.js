/*
 * 物件管理システムの Service Worker(通知 段階1・設計書 §4.5)。
 *
 * - 通知の表示と、押したときに画面を開くこと、サーバーからの受信(push・段階4a)を持つ。
 *   ⚠ページの読み込みは横取りしない(fetch を扱わない・キャッシュしない)。
 * - push の本文には「結び付け(binding_id)」が入る。保存している値(画面がログイン後に書く)と
 *   一致したときだけ中身(種類と件数)を出し、違う・無いときは中身の無い知らせだけを出す
 *   (共用 PC で前の人宛ての通知を次の人に見せない・設計書 §7.5)。
 * - 表示の依頼と後片付け(共用 PC で人が替わるとき)を**1本の順番待ち**で1件ずつ処理する。
 *   1件が失敗しても列は止めない。
 * - 「切り替えの世代」を IndexedDB に持つ。規則は src/lib/notifications/cleanup-state.ts と同じ
 *   (処理済みの cleanupId の一覧・最大100件・1日)。変えるときは両方を揃える。
 */
const SW_VERSION = 2;
const BINDING_KEY = "binding";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERIC_TITLE = "物件管理システム";
const GENERIC_BODY = "新しいお知らせがあります（ログインして確認してください）";
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
        // 後片付け(ログアウト・ログイン画面)では結び付けも消す(前の人宛ての push の中身を出さない)。
        store.delete(BINDING_KEY);
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

async function readBinding() {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(BINDING_KEY);
      req.onsuccess = () => resolve(typeof req.result === "string" && UUID_RE.test(req.result) ? req.result : null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

// 画面が付け替えに成功したときだけ書く。gen が今と違う依頼(前の人のまま開いていたタブ)は断る。
async function writeBinding(binding, gen) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      let ok = false;
      const req = store.get(STATE_KEY);
      req.onsuccess = () => {
        const state = normalize(req.result);
        if (state.gen !== gen) return;
        store.put(binding, BINDING_KEY);
        ok = true;
      };
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve(ok);
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
        reply({ ok: true, version: SW_VERSION, push: true, gen: state.gen });
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
        // 世代が今と違う(前の人のまま開いていたタブ)の依頼では、次の人の通知を閉じない。
        const state = await readState();
        if (data.gen !== state.gen) {
          reply({ ok: false, stale: true });
          return;
        }
        const list = await self.registration.getNotifications({ tag: data.tag });
        for (const n of list) {
          if (isOurs(n) && n.data.gen === state.gen) n.close();
        }
        reply({ ok: true });
      }).catch(() => reply({ ok: false })),
    );
    return;
  }

  // 付け替えに成功した結び付けを保存する(表示・後片付けと同じ順番待ち)。
  if (data.type === "binding") {
    event.waitUntil(
      enqueue(async () => {
        if (typeof data.binding !== "string" || !UUID_RE.test(data.binding) || typeof data.gen !== "number") {
          reply({ ok: false });
          return;
        }
        const ok = await writeBinding(data.binding.toLowerCase(), data.gen);
        reply(ok ? { ok: true } : { ok: false, stale: true });
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

// サーバーからの受信(段階4a)。本文 = { b: binding_id, title, body, tag, url }(種類と件数だけ)。
// ⚠保存値の読み取り→比較→表示を、後片付け(結び付けの消去)と同じ1本の順番待ちで処理する。
//   消去がこの表示の後ろに並んでいれば、表示済みの通知として閉じられる。さらに表示のあとで
//   保存値を読み直し、違っていれば(消えていれば)すぐ閉じる(設計書 §7.5)。
// ブラウザは push のたびに何か表示することを求めるので、中身を出せないときも中身の無い知らせを出す。
self.addEventListener("push", (event) => {
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }
  event.waitUntil(
    enqueue(async () => {
      const state = await readState();
      const binding = await readBinding();
      const matched =
        !!payload && typeof payload.b === "string" && binding !== null && payload.b.toLowerCase() === binding;
      if (!matched) {
        await self.registration.showNotification(GENERIC_TITLE, {
          body: GENERIC_BODY,
          tag: "pm-push-generic",
          data: { app: APP_TAG, gen: state.gen, url: "/home" },
        });
        return;
      }
      const tag = typeof payload.tag === "string" && payload.tag ? "pm-push:" + payload.tag : "pm-push";
      await self.registration.showNotification(String(payload.title || GENERIC_TITLE).slice(0, 80), {
        body: String(payload.body || "").slice(0, 200),
        tag,
        data: { app: APP_TAG, gen: state.gen, url: safePath(payload.url), b: binding },
      });
      const after = await readBinding();
      const afterState = await readState();
      if (after !== binding || afterState.gen !== state.gen) {
        const list = await self.registration.getNotifications({ tag });
        for (const n of list) {
          if (isOurs(n) && n.data.b === binding) n.close();
        }
      }
    }).catch(() =>
      self.registration.showNotification(GENERIC_TITLE, {
        body: GENERIC_BODY,
        tag: "pm-push-generic",
        data: { app: APP_TAG, gen: -1, url: "/home" },
      }),
    ),
  );
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
