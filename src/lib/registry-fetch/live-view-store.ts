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
  /**
   * 実行者が「中止」を押した印。provider が節目ごとに見て**自分で**止まる。
   * ⚠外から処理を殺さない。強制終了すると外部サイトを中途半端な状態
   * (カートに行だけ残る等)で放り出す恐れがある。
   */
  cancelRequested?: boolean;
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
 * ステップ進行を記録し、step の seq を返す (begin していない ref は -1 =
 * 誤配線でも検索本体を妨げない)。shot は同時指定 (直接添付) も後付け
 * (attachLiveShot) もでき、cap 内のときのみ保存する。
 */
export function reportLiveStep(
  userId: string,
  propertyId: string,
  liveRef: string,
  label: string,
  shot: Uint8Array | null,
): number {
  const entry = store.get(key(userId, propertyId, liveRef));
  if (!entry) return -1;
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
  return seq;
}

/**
 * 既存 step へスクショを後付けする (@codex R6: 撮影は検索本体の await
 * チェーンに乗せず fire-and-forget するため、step の記録と shot の到着が
 * 分離する)。エントリ/step が消えていれば黙って捨てる。cap は直接添付と同一。
 */
export function attachLiveShot(
  userId: string,
  propertyId: string,
  liveRef: string,
  seq: number,
  shot: Uint8Array,
): void {
  const k = key(userId, propertyId, liveRef);
  const entry = store.get(k);
  if (!entry) return;
  if (entry.shots.has(seq)) return;
  const stepIdx = entry.steps.findIndex((s) => s.seq === seq);
  if (stepIdx < 0) return;
  if (
    entry.shots.size >= LIVE_VIEW_MAX_SHOTS ||
    entry.totalShotBytes + shot.byteLength > LIVE_VIEW_MAX_TOTAL_SHOT_BYTES
  ) {
    return;
  }
  entry.shots.set(seq, shot);
  entry.totalShotBytes += shot.byteLength;
  entry.steps[stepIdx] = { ...entry.steps[stepIdx], hasShot: true };
  entry.updatedAt = Date.now();
  scheduleExpiry(k, entry);
}

/**
 * 中止の要求 (実行者本人のみ = key に userId を含むため他人は触れない)。
 *
 * ⚠**フラグを立てるだけ**。ここで処理を殺さない。外から強制終了すると、外部サイトを
 * 中途半端な状態 (カートに行だけ残る等) で放り出す恐れがある。実際に止まる場所は
 * provider が「安全な節目」として選ぶ。
 *
 * ⚠**課金後は止められない** (判断は provider 側)。請求を押した後に止めると
 * 「お金は払ったのに書類が手に入らない」状態を作るため、課金境界を越えたら
 * この要求は無視して最後まで取得しきる。
 *
 * @returns エントリが無い (期限切れ / 別人 / 既に完了) なら false
 */
export function requestLiveViewCancel(
  userId: string,
  propertyId: string,
  liveRef: string,
): boolean {
  const k = key(userId, propertyId, liveRef);
  const entry = store.get(k);
  if (!entry) return false;
  if (entry.done) return false; // 既に終わっている
  entry.cancelRequested = true;
  entry.updatedAt = Date.now();
  scheduleExpiry(k, entry);
  // ⚠**実況とは別に印を残す**(@codex #357 P2)。実況エントリの寿命は最終更新から
  // 3分だが、検索は**有料取得の待ち行列**に入ると長く待たされる(本数に上限が
  // 無い)。待っている間は更新が起きないので実況が先に期限切れで消え、順番が
  // 回ってきたときには中止の印も一緒に消えている
  // = **「中止しました」と言ったのに動き出す**。
  // この印は期限で消さない (片付けは route の finally とプロセス終了)。
  // 暴走時の保険として件数上限だけ持ち、古いものから捨てる。
  if (cancelMarks.size >= CANCEL_MARKS_MAX) {
    const oldest = cancelMarks.keys().next();
    if (!oldest.done) cancelMarks.delete(oldest.value);
  }
  cancelMarks.add(k);
  return true;
}

/**
 * 中止の印だけを、実況エントリより長く持つ置き場 (@codex #357 P2)。
 * ⚠ここに入れるのは**押された時刻だけ**。所在・スクショは持たない
 * (長生きさせてよいのは秘匿情報を含まないものに限る)。
 */
// ⚠保持するのは**鍵だけ**(所在・スクショ・時刻すら持たない)。
const cancelMarks = new Set<string>();

/**
 * ⚠**中止の印に期限は設けない** (@codex #357 P2)。
 *
 * 期限を置くと、それがどれだけ長くても「実行中なのに印が消える」窓になる。
 * 有料取得の待ち行列は本数に上限が無く、**何分にしても足りない場合がある**。
 * 15分→60分と延ばしたが、延ばす方向の対処は本質的に誤りだった。
 *
 * 印は次の 2 つで確実に片付く:
 *   1. その検索が終わったとき — route の finally → `clearLiveViewCancel`
 *   2. プロセスが落ちたとき — この Map はメモリ内なのでプロセスと一緒に消える
 * したがって残り続ける経路が無く、期限による掃除は不要。
 *
 * ⚠「印を付けたのに検索が始まらない」孤児は作れない: `requestLiveViewCancel` は
 * 実況エントリが無い/完了済みなら false を返して印を作らず、route は
 * `completeLiveView`(done=true) → `clearLiveViewCancel` の順で片付ける。
 * その隙間に届いた中止は done=true を見て弾かれる。
 *
 * 万一の暴走に備えた上限だけ持つ (下記 MAX)。
 */
const CANCEL_MARKS_MAX = 1000;

/**
 * 中止の印を消す (@codex #357 P2)。
 *
 * ⚠**その検索が終わった時点**で呼ぶ (route の finally)。印の寿命を
 * 「待ち時間の見積もり」に任せると、待ち行列が伸びたときに
 * **中止したはずの検索が動き出す**。終わりを知っている場所で消すのが正しい。
 */
export function clearLiveViewCancel(
  userId: string,
  propertyId: string,
  liveRef: string,
): void {
  const k = key(userId, propertyId, liveRef);
  cancelMarks.delete(k);
}

/** 中止が要求されているか (provider が節目ごとに見る)。 */
export function isLiveViewCancelRequested(
  userId: string,
  propertyId: string,
  liveRef: string,
): boolean {
  const k = key(userId, propertyId, liveRef);
  // 実況エントリが期限切れで消えていても、中止の印が残っていれば止める。
  return store.get(k)?.cancelRequested === true || cancelMarks.has(k);
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
  // 中止の印は実況より長生きするので、テスト間で持ち越さないよう明示的に消す。
  cancelMarks.clear();
}

export function __liveViewStoreSizeForTests(): number {
  return store.size;
}
