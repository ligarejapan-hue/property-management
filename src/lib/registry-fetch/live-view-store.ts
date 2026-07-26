/**
 * 実況パネル (謄本所在検索のライブ中継) のメモリ内ストア。
 *
 * 目的: 自動取得のヘッドレス操作を、実行した本人がアプリ内小窓で
 * 「スクショ紙芝居」として追えるようにする。検索 POST (同期) の実行中に
 * adapter がステップ毎の {ラベル + viewport スクショ} をここへ積み、
 * client は液晶越しに 1 秒ポーリングで読む。
 *
 * 規約 (candidate-cache.ts と同型・「その場限り」の徹底):
 *  - 単一プロセス (systemd 1 サービス) 前提の in-memory Map。DB / ディスク /
 *    localStorage へは一切永続しない。restart で消える (実況は再実行で見れば
 *    よい情報のため許容)。
 *  - スクショには所在・地番等が写るため、取得は実行者本人 (userId 一致) のみ
 *    = key に userId を含め、配信 route 側も session.id で引く。
 *  - TTL (最終更新から LIVE_VIEW_TTL_MS・完了後に眺め直す猶予込み) は
 *    scheduled expiry で実削除する (アクセスが来なくても必ず消える)。並行
 *    実況 (別タブ/二重送信) は保持し、同一 user×property の件数だけ上限で抑える。
 *  - shot は枚数 / 総バイト数 cap を超えたら保存しない (steps の文字進行は
 *    残す = パネルは文字だけでも成立する)。
 */

export interface LiveViewStep {
  seq: number;
  label: string;
  at: number;
  hasShot: boolean;
}

interface LiveViewEntry {
  steps: LiveViewStep[];
  shots: Map<number, Uint8Array>;
  totalShotBytes: number;
  done: boolean;
  updatedAt: number;
  /**
   * TTL 到達で自動削除するタイマー (@codex P2: prune がアクセス起点だけだと、
   * パネルが done で ポーリングを止めた後アクセスが来ず、所在の写るスクショが
   * プロセス内に残り続ける)。書き込みのたびに張り直し、発火で必ず消す。
   */
  expireTimer?: ReturnType<typeof setTimeout>;
}

/** 最終更新からの生存時間 (完了後にパネルを眺め直す猶予込み)。 */
export const LIVE_VIEW_TTL_MS = 3 * 60 * 1000;
/**
 * 同一 user×property の同時実況の上限 (@codex P2: 別タブ/二重送信の並行検索を
 * begin 時の全消しで壊さない。TTL の実削除が滞留を防ぐため、ここは並行数の
 * 抑えのみ・超過時は最古から削除)。
 */
export const LIVE_VIEW_MAX_PER_PROPERTY = 2;
/** 1 実行あたりのスクショ枚数上限 (候補ページ送り最大 20 + 前段ステップ)。 */
export const LIVE_VIEW_MAX_SHOTS = 30;
/** 1 実行あたりのスクショ総バイト上限 (viewport JPEG 想定・メモリ保護)。 */
export const LIVE_VIEW_MAX_TOTAL_SHOT_BYTES = 12 * 1024 * 1024;

const store = new Map<string, LiveViewEntry>();

/**
 * client 発行 liveRef の形式検証 (safeRandomId 由来の英数と -_ のみ)。
 * key の区切り文字 "/" や制御文字の混入を防ぐ。
 */
export function isValidLiveRef(ref: string): boolean {
  return /^[A-Za-z0-9_-]{8,64}$/.test(ref);
}

function key(userId: string, propertyId: string, liveRef: string): string {
  return `${userId}/${propertyId}/${liveRef}`;
}

function prefix(userId: string, propertyId: string): string {
  return `${userId}/${propertyId}/`;
}

/** エントリ削除は必ずここを通す (残タイマーが同一 key の新エントリを誤削除しない)。 */
function deleteEntry(k: string): void {
  const entry = store.get(k);
  if (entry?.expireTimer) clearTimeout(entry.expireTimer);
  store.delete(k);
}

/**
 * 書き込みのたびに TTL タイマーを張り直す。発火時点 = 最終書き込みから TTL
 * 経過なので無条件に削除できる (アクセスが一切来なくても必ず消える)。
 * unref でこのタイマーがプロセスの生存を延ばさないようにする (Node 専用 API
 * のため optional call・テストの fake timers でも安全)。
 */
function scheduleExpiry(k: string, entry: LiveViewEntry): void {
  if (entry.expireTimer) clearTimeout(entry.expireTimer);
  const timer = setTimeout(() => {
    store.delete(k);
  }, LIVE_VIEW_TTL_MS);
  (timer as { unref?: () => void }).unref?.();
  entry.expireTimer = timer;
}

function pruneExpired(now: number): void {
  for (const [k, v] of store) {
    if (now - v.updatedAt > LIVE_VIEW_TTL_MS) deleteEntry(k);
  }
}

/**
 * 実行開始。並行実況 (別タブ/二重送信 = 別 liveRef) は壊さず保持し、同一
 * user×property のエントリ数だけ上限で抑える (超過は最古から削除)。滞留の
 * 防止自体は scheduled expiry (TTL の実削除) が担う。
 */
export function beginLiveView(
  userId: string,
  propertyId: string,
  liveRef: string,
): void {
  const now = Date.now();
  pruneExpired(now);
  const k = key(userId, propertyId, liveRef);
  // 同一 key の再開始は旧エントリ (とその expire タイマー) を先に片付ける
  // (残タイマーが新エントリを誤削除しない)。
  deleteEntry(k);
  const entry: LiveViewEntry = {
    steps: [],
    shots: new Map(),
    totalShotBytes: 0,
    done: false,
    updatedAt: now,
  };
  store.set(k, entry);
  scheduleExpiry(k, entry);
  // 並行数の上限 (最古から削除)。
  const p = prefix(userId, propertyId);
  const siblings: Array<[string, LiveViewEntry]> = [];
  for (const [sk, sv] of store) {
    if (sk.startsWith(p)) siblings.push([sk, sv]);
  }
  if (siblings.length > LIVE_VIEW_MAX_PER_PROPERTY) {
    siblings.sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    const excess = siblings.length - LIVE_VIEW_MAX_PER_PROPERTY;
    for (let i = 0; i < excess; i++) {
      deleteEntry(siblings[i][0]);
    }
  }
}

/**
 * ステップ進行を記録する。begin していない ref は無視 (誤配線でも検索本体を
 * 妨げない)。shot は cap 内のときのみ保存し、超過時は文字進行だけ残す。
 */
export function reportLiveStep(
  userId: string,
  propertyId: string,
  liveRef: string,
  label: string,
  shot: Uint8Array | null,
): void {
  const entry = store.get(key(userId, propertyId, liveRef));
  if (!entry) return;
  const now = Date.now();
  const seq = entry.steps.length;
  let stored = false;
  if (
    shot &&
    entry.shots.size < LIVE_VIEW_MAX_SHOTS &&
    entry.totalShotBytes + shot.byteLength <= LIVE_VIEW_MAX_TOTAL_SHOT_BYTES
  ) {
    entry.shots.set(seq, shot);
    entry.totalShotBytes += shot.byteLength;
    stored = true;
  }
  entry.steps.push({ seq, label, at: now, hasShot: stored });
  entry.updatedAt = now;
  scheduleExpiry(key(userId, propertyId, liveRef), entry);
}

/** 実行完了 (成功・失敗とも)。エントリは TTL まで閲覧可能なまま残る。 */
export function completeLiveView(
  userId: string,
  propertyId: string,
  liveRef: string,
): void {
  const entry = store.get(key(userId, propertyId, liveRef));
  if (!entry) return;
  entry.done = true;
  entry.updatedAt = Date.now();
  scheduleExpiry(key(userId, propertyId, liveRef), entry);
}

/** 進行状況の取得 (実行者本人のみ = userId が key に一致する場合のみ)。 */
export function getLiveView(
  userId: string,
  propertyId: string,
  liveRef: string,
): { steps: LiveViewStep[]; done: boolean } | null {
  pruneExpired(Date.now());
  const entry = store.get(key(userId, propertyId, liveRef));
  if (!entry) return null;
  return { steps: entry.steps.slice(), done: entry.done };
}

/** ステップのスクショ取得 (無ければ null)。 */
export function getLiveShot(
  userId: string,
  propertyId: string,
  liveRef: string,
  seq: number,
): Uint8Array | null {
  pruneExpired(Date.now());
  const entry = store.get(key(userId, propertyId, liveRef));
  if (!entry) return null;
  return entry.shots.get(seq) ?? null;
}

export function __clearLiveViewStoreForTests(): void {
  for (const k of Array.from(store.keys())) deleteEntry(k);
  store.clear();
}

export function __liveViewStoreSizeForTests(): number {
  return store.size;
}
