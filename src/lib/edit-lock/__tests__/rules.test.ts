import { describe, it, expect } from "vitest";
import {
  EDIT_LOCK_HEARTBEAT_GRACE_MS,
  EDIT_LOCK_HEARTBEAT_INTERVAL_MS,
  EDIT_LOCK_IDLE_LIMIT_MS,
  EDIT_LOCK_IDLE_WARN_MS,
  EDIT_LOCK_STATUS_POLL_MS,
  EDIT_LOCK_STATUS_CHUNK_SIZE,
  EDIT_LOCK_MESSAGE_LOOKUP_TIMEOUT_MS,
  evaluateLock,
  expiryCause,
  isLockExpired,
  type EditLockRow,
} from "../rules";
import { IDLE_TIMEOUT_MS } from "@/lib/idle-timeout";

const NOW = new Date("2026-09-18T10:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const row = (over: Partial<EditLockRow> = {}): EditLockRow => ({
  id: "11111111-1111-4111-8111-111111111111",
  userId: "user-a",
  screenTokenHash: "hash-a",
  acquiredAt: ago(60_000),
  heartbeatAt: ago(10_000),
  activityAt: ago(10_000),
  forceReleasedAt: null,
  ...over,
});
const A = { userId: "user-a", screenTokenHash: "hash-a" };
const A2 = { userId: "user-a", screenTokenHash: "hash-a2" };
const B = { userId: "user-b", screenTokenHash: "hash-b" };

describe("定数", () => {
  it("無操作の上限は自動ログアウトと一致する", () => {
    expect(EDIT_LOCK_IDLE_LIMIT_MS).toBe(IDLE_TIMEOUT_MS);
  });
  // review Important 4: 以下は SQL 側のしきい値と同じ定数から導かれるため、値そのものを
  // 1行 assert しないと、5分を5秒に書き換えてもテストスイート全体が緑のまま通ってしまう。
  it("合図の猶予は5分(D4: 発注者決定・墓標の期限もこの値を使う[H7])", () => {
    expect(EDIT_LOCK_HEARTBEAT_GRACE_MS).toBe(5 * 60_000);
  });
  it("合図の間隔は30秒(2.3節)", () => {
    expect(EDIT_LOCK_HEARTBEAT_INTERVAL_MS).toBe(30_000);
  });
  it("無操作の予告は55分(D5の5分前・2.3節)", () => {
    expect(EDIT_LOCK_IDLE_WARN_MS).toBe(55 * 60_000);
  });
  it("状態の再確認間隔は30秒(2.3節)", () => {
    expect(EDIT_LOCK_STATUS_POLL_MS).toBe(30_000);
  });
  // 横断レビュー M3: 第2段が足した2定数にも値そのものを固定する assertion が
  // 無かった(既存5定数は H4 で全部足した先例がある)。
  // ⚠特に50は、`status-controller.test.ts` が `toHaveLength(EDIT_LOCK_STATUS_CHUNK_SIZE)`
  //   =自分の定数を自分で照合しているため、仕様§4.5の「50」がどこにも固定されて
  //   いなかった。窓口の zod スキーマ(`.max()`)もこの定数を読む=値を変えると
  //   サーバの受付上限も一緒に動くので、値の固定はここが唯一の砦。
  it("状態窓口の1回の上限は50件(仕様4.5・窓口のzodスキーマと共有)", () => {
    expect(EDIT_LOCK_STATUS_CHUNK_SIZE).toBe(50);
  });
  it("423の文言組み立ての上限時間は10秒(round3 Minor H の裁定値)", () => {
    expect(EDIT_LOCK_MESSAGE_LOOKUP_TIMEOUT_MS).toBe(10_000);
  });
});

describe("isLockExpired", () => {
  it("合図が猶予内・操作が上限内なら生きている", () => {
    expect(isLockExpired(row(), NOW)).toBe(false);
  });
  it("合図が猶予を1ミリ秒超えたら期限切れ", () => {
    expect(isLockExpired(row({ heartbeatAt: ago(EDIT_LOCK_HEARTBEAT_GRACE_MS + 1) }), NOW)).toBe(true);
  });
  it("合図はちょうど猶予なら生きている(境界)", () => {
    expect(isLockExpired(row({ heartbeatAt: ago(EDIT_LOCK_HEARTBEAT_GRACE_MS) }), NOW)).toBe(false);
  });
  it("操作が上限を超えたら期限切れ", () => {
    expect(isLockExpired(row({ activityAt: ago(EDIT_LOCK_IDLE_LIMIT_MS + 1) }), NOW)).toBe(true);
  });
});

describe("expiryCause: それぞれの上限で判定する", () => {
  it("合図6分・操作50分 は heartbeat(古さの大小で決めない)", () => {
    expect(expiryCause(row({ heartbeatAt: ago(6 * 60_000), activityAt: ago(50 * 60_000) }), NOW)).toBe("heartbeat");
  });
  it("合図1分・操作61分 は idle", () => {
    expect(expiryCause(row({ heartbeatAt: ago(60_000), activityAt: ago(61 * 60_000) }), NOW)).toBe("idle");
  });
  it("両方超えていたら heartbeat を優先", () => {
    expect(expiryCause(row({ heartbeatAt: ago(6 * 60_000), activityAt: ago(61 * 60_000) }), NOW)).toBe("heartbeat");
  });
  it("期限内なら null", () => {
    expect(expiryCause(row(), NOW)).toBeNull();
  });
});

describe("evaluateLock: 総当たり", () => {
  it("鍵が無ければ空き", () => {
    expect(evaluateLock(null, NOW, A)).toEqual({ state: "free" });
  });
  it("同じ利用者・同じ画面なら自分のもの", () => {
    expect(evaluateLock(row(), NOW, A)).toMatchObject({ state: "mine" });
  });
  it("同じ利用者・別の画面は待つ側(D6)", () => {
    expect(evaluateLock(row(), NOW, A2)).toMatchObject({ state: "held_by_self_other_screen" });
  });
  it("別の利用者は他人の鍵", () => {
    expect(evaluateLock(row(), NOW, B)).toMatchObject({ state: "held_by_other", holderUserId: "user-a" });
  });
  it("期限切れは誰から見ても空き", () => {
    const expired = row({ heartbeatAt: ago(EDIT_LOCK_HEARTBEAT_GRACE_MS + 1) });
    for (const who of [A, A2, B]) {
      expect(evaluateLock(expired, NOW, who)).toEqual({ state: "free" });
    }
  });
  it("管理者に外された鍵は、外された本人には force_released_mine・他人には空き", () => {
    const killed = row({ forceReleasedAt: ago(1_000) });
    expect(evaluateLock(killed, NOW, A)).toMatchObject({ state: "force_released_mine" });
    expect(evaluateLock(killed, NOW, A2)).toEqual({ state: "free" });
    expect(evaluateLock(killed, NOW, B)).toEqual({ state: "free" });
  });
  it("期限切れかつ外された鍵も空き(外された本人以外)", () => {
    const both = row({ forceReleasedAt: ago(1_000), heartbeatAt: ago(EDIT_LOCK_HEARTBEAT_GRACE_MS + 1) });
    expect(evaluateLock(both, NOW, B)).toEqual({ state: "free" });
  });

  // review Important 7(H7): 墓標(force_released_at)にも期限が無いと、管理者に外された
  // 本人が編集ウィンドウを開かない入口(プルダウン・地番ポップアップ)から保存し続ける限り
  // 無期限に断られる。5分(EDIT_LOCK_HEARTBEAT_GRACE_MS)を過ぎたら空きとして扱う。
  it("墓標は猶予(5分)を過ぎたら、外された本人から見ても空き(H7)", () => {
    const expiredTombstone = row({ forceReleasedAt: ago(EDIT_LOCK_HEARTBEAT_GRACE_MS + 1) });
    for (const who of [A, A2, B]) {
      expect(evaluateLock(expiredTombstone, NOW, who)).toEqual({ state: "free" });
    }
  });
  it("墓標はちょうど猶予までは有効(境界)", () => {
    const boundaryTombstone = row({ forceReleasedAt: ago(EDIT_LOCK_HEARTBEAT_GRACE_MS) });
    expect(evaluateLock(boundaryTombstone, NOW, A)).toMatchObject({ state: "force_released_mine" });
  });
});
