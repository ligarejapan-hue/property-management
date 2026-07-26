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
 *  - 追加時に期限切れ prune + 同一 user×property の旧エントリ破棄。TTL は
 *    最終更新から LIVE_VIEW_TTL_MS (完了後に眺め直す猶予を含む)。
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
}

/** 最終更新からの生存時間 (完了後にパネルを眺め直す猶予込み)。 */
export const LIVE_VIEW_TTL_MS = 3 * 60 * 1000;
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

function pruneExpired(now: number): void {
  for (const [k, v] of store) {
    if (now - v.updatedAt > LIVE_VIEW_TTL_MS) store.delete(k);
  }
}

/** 実行開始。同一 user×property の旧実況は破棄する (滞留防止)。 */
export function beginLiveView(
  userId: string,
  propertyId: string,
  liveRef: string,
): void {
  const now = Date.now();
  pruneExpired(now);
  const p = prefix(userId, propertyId);
  for (const k of store.keys()) {
    if (k.startsWith(p)) store.delete(k);
  }
  store.set(key(userId, propertyId, liveRef), {
    steps: [],
    shots: new Map(),
    totalShotBytes: 0,
    done: false,
    updatedAt: now,
  });
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
  store.clear();
}

export function __liveViewStoreSizeForTests(): number {
  return store.size;
}
