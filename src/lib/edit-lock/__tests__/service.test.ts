import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number; code: string;
    constructor(status: number, message: string, code = "ERROR") { super(message); this.status = status; this.code = code; }
  }
  return { ApiError: MockApiError };
});

import {
  acquireEditLock,
  assertNotEditLockedByOther,
  deleteEditLocksFor,
  forceReleaseEditLock,
  heartbeatEditLock,
  isResourceEditLocked,
  readEditLocks,
  releaseEditLock,
} from "../service";
import { EDIT_LOCK_HEARTBEAT_GRACE_MS, EDIT_LOCK_IDLE_LIMIT_MS, expiryCause, type EditLockRow } from "../rules";

/** $queryRaw のテンプレートを1本の文字列に戻す(条件式の検査用)。 */
function sqlOf(call: unknown[]): string {
  const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
  return strings.reduce((acc, s, i) => acc + s + (i < values.length ? `{${String(values[i])}}` : ""), "");
}

function fakeDb(result: unknown[] = []) {
  const queryRaw = vi.fn().mockResolvedValue(result);
  return { queryRaw, db: { $queryRaw: queryRaw } as never };
}

const GRACE_SEC = EDIT_LOCK_HEARTBEAT_GRACE_MS / 1000;
const IDLE_SEC = EDIT_LOCK_IDLE_LIMIT_MS / 1000;

/**
 * `heartbeat_at` が GRACE_SEC(5分)、`activity_at` が IDLE_SEC(60分)で判定されている
 * ことを、列名としきい値を1本の正規表現で結びつけて確認する(コントローラ指摘②)。
 * 片方だけ見る assert だと「合図5分・操作60分」が逆(合図60分・操作5分)になっても
 * 全テストが通ってしまう。`::double precision` キャスト(コントローラ指摘③)もここで固定する。
 */
function expectColumnThresholds(sql: string): void {
  expect(sql).toMatch(
    new RegExp(
      `"heartbeat_at"[\\s\\S]*?make_interval\\(secs => \\{${GRACE_SEC}\\}::double precision\\)` +
        `[\\s\\S]*?"activity_at"[\\s\\S]*?make_interval\\(secs => \\{${IDLE_SEC}\\}::double precision\\)`,
    ),
  );
}

const BASE = {
  resourceType: "property" as const,
  resourceId: "22222222-2222-4222-8222-222222222222",
  userId: "33333333-3333-4333-8333-333333333333",
  screenTokenHash: "hash-a",
};

beforeEach(() => vi.clearAllMocks());

describe("acquireEditLock", () => {
  it("取得できたら世代(lockId)を返す", async () => {
    const { db, queryRaw } = fakeDb([]);
    queryRaw
      .mockResolvedValueOnce([]) // 既存の読み取り
      .mockResolvedValueOnce([{ id: "44444444-4444-4444-8444-444444444444", acquired_at: new Date("2026-09-18T10:00:00Z") }]);
    const res = await acquireEditLock(db, BASE);
    expect(res).toMatchObject({ state: "mine", lockId: "44444444-4444-4444-8444-444444444444" });
  });

  it("取得のSQLは 期限切れ・解除済み・同じ保持者 のときだけ上書きし、世代を振り直す", async () => {
    const { db, queryRaw } = fakeDb([]);
    queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "x", acquired_at: new Date() }]);
    await acquireEditLock(db, BASE);
    const sql = sqlOf(queryRaw.mock.calls[1]);
    expect(sql).toMatch(/ON CONFLICT \("resource_type", "resource_id"\) DO UPDATE/);
    expect(sql).toMatch(/SET[\s\S]*"id" = gen_random_uuid\(\)/);
    expect(sql).toMatch(/"force_released_at" = NULL/);
    expect(sql).toMatch(/WHERE[\s\S]*"edit_locks"\."force_released_at" IS NOT NULL/);
    // ⚠brief の Step1 サンプルは "now()" だが、Global Constraint(clock_timestamp() を使う・
    // 行ロック待ちで書いた直後の鍵が期限切れにならないように)と Step3 サンプル自体が
    // clock_timestamp() を使っているため、こちらに合わせて固定する。
    expectColumnThresholds(sql);
    expect(sql).toMatch(/"edit_locks"\."user_id" = EXCLUDED\."user_id" AND "edit_locks"\."screen_token_hash" = EXCLUDED\."screen_token_hash"/);
  });

  it("0件なら他人が保持中として現在の行を返す", async () => {
    const { db, queryRaw } = fakeDb([]);
    const current = { id: "l1", user_id: "other", screen_token_hash: "h", acquired_at: new Date(), heartbeat_at: new Date(), activity_at: new Date(), force_released_at: null };
    queryRaw.mockResolvedValueOnce([current]).mockResolvedValueOnce([]).mockResolvedValueOnce([current]);
    const res = await acquireEditLock(db, BASE);
    expect(res).toMatchObject({ state: "held" });
  });

  describe("takeover(横取り)の判定", () => {
    // ⚠これは acquire 経路の中で唯一 SQL の WHERE ではなく JS 側で決めている分岐
    // (sameScreen の比較)。SQL がどう判定したか(prevRows の1本目のクエリ)を
    // 直接モックして、takeover の中身を固定する。
    it("期限切れ+別人 ⇒ takeover に前の保持者と原因が入る", async () => {
      const { db, queryRaw } = fakeDb([]);
      queryRaw
        .mockResolvedValueOnce([{ user_id: "other", screen_token_hash: "h-other", expired_by: "heartbeat" }])
        .mockResolvedValueOnce([{ id: "new-lock", acquired_at: new Date("2026-09-18T10:00:00Z") }]);
      const res = await acquireEditLock(db, BASE);
      if (res.state !== "mine") throw new Error("expected mine");
      expect(res.takeover).toEqual({ previousUserId: "other", expiredBy: "heartbeat" });
    });

    it("期限切れ+同じ利用者でも別タブ(合言葉違い)なら横取り扱い(D6)", async () => {
      const { db, queryRaw } = fakeDb([]);
      queryRaw
        .mockResolvedValueOnce([{ user_id: BASE.userId, screen_token_hash: "other-tab-hash", expired_by: "idle" }])
        .mockResolvedValueOnce([{ id: "new-lock", acquired_at: new Date("2026-09-18T10:00:00Z") }]);
      const res = await acquireEditLock(db, BASE);
      if (res.state !== "mine") throw new Error("expected mine");
      expect(res.takeover).toEqual({ previousUserId: BASE.userId, expiredBy: "idle" });
    });

    it("同じ利用者・同じ合言葉(同じ画面の取り直し)なら takeover は null", async () => {
      const { db, queryRaw } = fakeDb([]);
      // sameScreen が真なら、たとえ expired_by が付いていても takeover は立てない
      // (sameScreen の分岐そのものを検証する。実際の DB では同一画面が期限切れになる前に
      // 合図で延びているはずだが、ここでは JS 側の分岐ロジックだけを切り出して確かめる)。
      queryRaw
        .mockResolvedValueOnce([{ user_id: BASE.userId, screen_token_hash: BASE.screenTokenHash, expired_by: "heartbeat" }])
        .mockResolvedValueOnce([{ id: "new-lock", acquired_at: new Date("2026-09-18T10:00:00Z") }]);
      const res = await acquireEditLock(db, BASE);
      if (res.state !== "mine") throw new Error("expected mine");
      expect(res.takeover).toBeNull();
    });

    it("横取りの原因を計算するSQLは heartbeat_at を activity_at より先に見る", async () => {
      const { db, queryRaw } = fakeDb([]);
      queryRaw
        .mockResolvedValueOnce([{ user_id: "other", screen_token_hash: "h-other", expired_by: "heartbeat" }])
        .mockResolvedValueOnce([{ id: "new-lock", acquired_at: new Date("2026-09-18T10:00:00Z") }]);
      await acquireEditLock(db, BASE);
      const sql = sqlOf(queryRaw.mock.calls[0]);
      expectColumnThresholds(sql);
      expect(sql).toMatch(
        new RegExp(
          `WHEN "heartbeat_at" < clock_timestamp\\(\\) - make_interval\\(secs => \\{${GRACE_SEC}\\}::double precision\\) THEN 'heartbeat'` +
            `[\\s\\S]*WHEN "activity_at" < clock_timestamp\\(\\) - make_interval\\(secs => \\{${IDLE_SEC}\\}::double precision\\) THEN 'idle'`,
        ),
      );
    });
  });
});

describe("heartbeatEditLock", () => {
  it("操作があったときだけ activity_at を進める", async () => {
    const { db, queryRaw } = fakeDb([{ id: "l1" }]);
    await heartbeatEditLock(db, { ...BASE, active: true });
    const sql = sqlOf(queryRaw.mock.calls[0]);
    // ⚠Global Constraint により now() ではなく clock_timestamp()(brief Step1 の "now()" は古い記述)。
    expect(sql).toMatch(/"heartbeat_at" = clock_timestamp\(\)/);
    expect(sql).toMatch(/"activity_at" = CASE WHEN \{true\} THEN clock_timestamp\(\) ELSE "activity_at" END/);
    expect(sql).toMatch(/"force_released_at" IS NULL/);
    expectColumnThresholds(sql);
  });

  it("更新できなければ、DBが判定した現在の状態(dbNow付き)を返す(アプリの時計で判定し直さない)", async () => {
    const dbNow = new Date("2026-09-18T11:00:00Z");
    const currentRaw = {
      id: "l1",
      resource_type: "property",
      resource_id: BASE.resourceId,
      user_id: "other",
      screen_token_hash: "h-other",
      acquired_at: new Date("2026-09-18T10:00:00Z"),
      heartbeat_at: new Date("2026-09-18T10:00:00Z"),
      activity_at: new Date("2026-09-18T10:00:00Z"),
      force_released_at: null,
      db_now: dbNow,
    };
    const { db, queryRaw } = fakeDb([]);
    queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([currentRaw]);
    const res = await heartbeatEditLock(db, { ...BASE, active: true });
    expect(res).toMatchObject({
      ok: false,
      dbNow,
      current: { id: "l1", userId: "other", screenTokenHash: "h-other" },
    });
  });
});

describe("releaseEditLock", () => {
  it("世代と保持者が一致し、墓標でない行だけ消す", async () => {
    const { db, queryRaw } = fakeDb([]);
    await releaseEditLock(db, { ...BASE, lockId: "l1" });
    const sql = sqlOf(queryRaw.mock.calls[0]);
    expect(sql).toMatch(/DELETE FROM "edit_locks"/);
    expect(sql).toMatch(/"id" = \{l1\}/);
    expect(sql).toMatch(/"user_id" = \{33333333-3333-4333-8333-333333333333\}/);
    expect(sql).toMatch(/"screen_token_hash" = \{hash-a\}/);
    expect(sql).toMatch(/"force_released_at" IS NULL/);
  });
});

describe("forceReleaseEditLock", () => {
  it("世代と資源の両方が一致した行にだけ墓標を立てる", async () => {
    const { db, queryRaw } = fakeDb([{ user_id: "victim" }]);
    const res = await forceReleaseEditLock(db, { resourceType: "property", resourceId: BASE.resourceId, lockId: "l1", adminUserId: "admin" });
    const sql = sqlOf(queryRaw.mock.calls[0]);
    expect(sql).toMatch(/UPDATE "edit_locks"/);
    // ⚠Global Constraint により now() ではなく clock_timestamp()。
    expect(sql).toMatch(/"force_released_at" = clock_timestamp\(\)/);
    expect(sql).toMatch(/"id" = \{l1\}/);
    expect(sql).toMatch(/"resource_type" = /);
    expect(sql).toMatch(/"resource_id" = /);
    expect(res).toEqual({ previousUserId: "victim" });
  });
});

describe("readEditLocks", () => {
  it("DB の今時刻(dbNow)と生の行を返す。分類は呼び出し側の evaluateLock に任せる", async () => {
    const dbNow = new Date("2026-09-18T12:00:00Z");
    const raw = {
      id: "l1",
      resource_type: "owner",
      resource_id: "55555555-5555-4555-8555-555555555555",
      user_id: "u1",
      screen_token_hash: "h1",
      acquired_at: new Date("2026-09-18T10:00:00Z"),
      heartbeat_at: new Date("2026-09-18T10:00:00Z"),
      activity_at: new Date("2026-09-18T10:00:00Z"),
      force_released_at: null,
      db_now: dbNow,
    };
    const { db, queryRaw } = fakeDb([raw]);
    const res = await readEditLocks(db, [{ resourceType: "owner", resourceId: raw.resource_id }]);
    expect(res.dbNow).toEqual(dbNow);
    expect(res.locks).toEqual([
      {
        id: "l1",
        resourceType: "owner",
        resourceId: raw.resource_id,
        userId: "u1",
        screenTokenHash: "h1",
        acquiredAt: raw.acquired_at,
        heartbeatAt: raw.heartbeat_at,
        activityAt: raw.activity_at,
        forceReleasedAt: null,
      },
    ]);
    // 分類(active/force_released)を SQL 側で計算していない = DbClassifiedLock を作らない方針の確認。
    const sql = sqlOf(queryRaw.mock.calls[0]);
    expect(sql).not.toMatch(/AS active/);
    expect(sql).not.toMatch(/AS force_released/);
    expect(sql).toMatch(/clock_timestamp\(\) AS db_now/);
  });

  it("空配列なら問い合わせずに空を返す", async () => {
    const { db, queryRaw } = fakeDb([]);
    const res = await readEditLocks(db, []);
    expect(res.locks).toEqual([]);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  // review Minor 7: 修理前は ("resource_type"::text, "resource_id"::text) という形で
  // 列側を text に落としていたため、大文字混じりの UUID が uuid としては一致するのに
  // text としては一致せず、鍵だけが消えずに残る(資源が消えた後の孤児)可能性があった。
  // 列側はキャストせず(enum/uuid のまま)、unnest 側を同じ型にキャストする形にする。
  it("列側を text へ落とさず、unnest 側を enum/uuid にキャストして比較する(大文字UUIDでも一致させる)", async () => {
    const { db, queryRaw } = fakeDb([]);
    await readEditLocks(db, [
      { resourceType: "owner", resourceId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" },
    ]);
    const sql = sqlOf(queryRaw.mock.calls[0]);
    expect(sql).not.toMatch(/"resource_id"::text/);
    expect(sql).not.toMatch(/"resource_type"::text/);
    expect(sql).toMatch(/i::uuid/);
    expect(sql).toMatch(/t::"EditLockResource"/);
  });
});

describe("isResourceEditLocked", () => {
  it("DBの now() で判定し、保持者の有無を問わず真偽だけを返す", async () => {
    const { db, queryRaw } = fakeDb([{ locked: true }]);
    const res = await isResourceEditLocked(db, { resourceType: "property", resourceId: BASE.resourceId });
    expect(res).toBe(true);
    const sql = sqlOf(queryRaw.mock.calls[0]);
    expect(sql).toMatch(/EXISTS/);
    expect(sql).toMatch(/clock_timestamp\(\)/);
    expect(sql).toMatch(/"force_released_at" IS NULL/);
    expectColumnThresholds(sql);
  });

  it("行が無ければ false", async () => {
    const { db } = fakeDb([{ locked: false }]);
    const res = await isResourceEditLocked(db, { resourceType: "property", resourceId: BASE.resourceId });
    expect(res).toBe(false);
  });
});

describe("deleteEditLocksFor", () => {
  it("指定した資源の鍵をまとめて消す", async () => {
    const { db, queryRaw } = fakeDb([{ id: "l1" }, { id: "l2" }]);
    const res = await deleteEditLocksFor(db, [
      { resourceType: "property", resourceId: BASE.resourceId },
      { resourceType: "owner", resourceId: "66666666-6666-4666-8666-666666666666" },
    ]);
    expect(res).toBe(2);
    const sql = sqlOf(queryRaw.mock.calls[0]);
    expect(sql).toMatch(/DELETE FROM "edit_locks"/);
  });

  it("空配列なら問い合わせずに0を返す", async () => {
    const { db, queryRaw } = fakeDb([]);
    const res = await deleteEditLocksFor(db, []);
    expect(res).toBe(0);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  // review Minor 7: readEditLocks と同じ理由。大文字混じりの UUID が渡っても、
  // 列側(uuid型)と unnest側(uuid にキャストした値)がネイティブ型どうしで比較され、
  // 消せずに残る孤児鍵を防ぐ。
  it("列側を text へ落とさず、unnest 側を enum/uuid にキャストして比較する(大文字UUIDでも一致させる)", async () => {
    const { db, queryRaw } = fakeDb([{ id: "l1" }]);
    await deleteEditLocksFor(db, [
      { resourceType: "property", resourceId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" },
    ]);
    const sql = sqlOf(queryRaw.mock.calls[0]);
    expect(sql).not.toMatch(/"resource_id"::text/);
    expect(sql).not.toMatch(/"resource_type"::text/);
    expect(sql).toMatch(/i::uuid/);
    expect(sql).toMatch(/t::"EditLockResource"/);
  });
});

describe("assertNotEditLockedByOther", () => {
  // ⚠この窓口は SQL 側で active / force_released を計算して返す(DBの時計が権威)。
  const holder = (over: Record<string, unknown> = {}) => [{
    user_id: "other", screen_token_hash: "h-other", force_released: false, active: true, ...over,
  }];

  it("他人が持っていれば 423 EDIT_LOCKED", async () => {
    const { db } = fakeDb(holder());
    await expect(assertNotEditLockedByOther(db, { ...BASE, lockId: null })).rejects.toMatchObject({ status: 423, code: "EDIT_LOCKED" });
  });
  it("墓標は世代の検査より先に見る(世代つきの保存でも FORCE_RELEASED が出る)", async () => {
    const { db } = fakeDb([{ id: "lock-1", user_id: BASE.userId, screen_token_hash: BASE.screenTokenHash, force_released: true, active: false }]);
    await expect(assertNotEditLockedByOther(db, { ...BASE, lockId: "lock-1" })).rejects.toMatchObject({
      status: 423, code: "EDIT_LOCK_FORCE_RELEASED",
    });
  });
  it("自分の墓標なら 423 EDIT_LOCK_FORCE_RELEASED", async () => {
    const { db } = fakeDb(holder({ user_id: BASE.userId, screen_token_hash: BASE.screenTokenHash, force_released: true, active: false }));
    await expect(assertNotEditLockedByOther(db, { ...BASE, lockId: null })).rejects.toMatchObject({ status: 423, code: "EDIT_LOCK_FORCE_RELEASED" });
  });
  it("期限の判定はDBの now() で行う(SQL側で active を計算する)", async () => {
    const { db, queryRaw } = fakeDb([]);
    await assertNotEditLockedByOther(db, { ...BASE, lockId: null });
    const sql = sqlOf(queryRaw.mock.calls[0]);
    expect(sql).toMatch(/AS active/);
    // ⚠Global Constraint により now() ではなく clock_timestamp()。
    expect(sql).toMatch(/clock_timestamp\(\) - make_interval/);
    expectColumnThresholds(sql);
  });
  it("自分の鍵なら通す", async () => {
    const { db } = fakeDb(holder({ user_id: BASE.userId, screen_token_hash: BASE.screenTokenHash }));
    await expect(assertNotEditLockedByOther(db, { ...BASE, lockId: null })).resolves.toBeUndefined();
  });
  it("世代を持つ保存は、その世代が今の鍵と一致しないと 423 EDIT_LOCK_STALE", async () => {
    // 管理者が外す → 別の人が取って外す(墓標は消える) → 元の画面の遅れた保存、を想定。
    const { db } = fakeDb([]); // 鍵の行がもう無い
    await expect(assertNotEditLockedByOther(db, { ...BASE, lockId: "lock-old" })).rejects.toMatchObject({
      status: 423, code: "EDIT_LOCK_STALE",
    });
  });
  it("他人の世代を貼り付けても通らない(保持者が違えば 423)", async () => {
    const { db } = fakeDb([{ id: "lock-1", user_id: "other", screen_token_hash: "h-other", force_released: false, active: true }]);
    await expect(assertNotEditLockedByOther(db, { ...BASE, lockId: "lock-1" })).rejects.toMatchObject({ status: 423 });
  });
  it("世代が今の鍵と一致すれば通す", async () => {
    const { db } = fakeDb([{ id: "lock-1", user_id: BASE.userId, screen_token_hash: BASE.screenTokenHash, force_released: false, active: true }]);
    await expect(assertNotEditLockedByOther(db, { ...BASE, lockId: "lock-1" })).resolves.toBeUndefined();
  });
  it("鍵が無ければ通す(合言葉が無い古い画面も同じ)", async () => {
    const { db } = fakeDb([]);
    await expect(assertNotEditLockedByOther(db, { ...BASE, screenTokenHash: null, lockId: null })).resolves.toBeUndefined();
  });
  it("他人が持っていて合言葉が無ければ、再読み込みの案内を文言に足す", async () => {
    const { db } = fakeDb(holder());
    await expect(assertNotEditLockedByOther(db, { ...BASE, screenTokenHash: null, lockId: null })).rejects.toMatchObject({
      status: 423,
      message: expect.stringContaining("再読み込み"),
    });
  });
});

describe("SQL の期限しきい値と rules.ts の一致(コントローラ決定②)", () => {
  it("SQL の make_interval 秒数は rules.ts の定数から導き、expiryCause と同じ境界で切り替わる", async () => {
    // SQL 側: rules.ts の定数から導いた秒数がそのまま現れる(手で決め打ちした別の値になっていない)。
    // ⚠`::double precision` キャストも一緒に固定する(コントローラ指摘③)。
    const { db, queryRaw } = fakeDb([]);
    await assertNotEditLockedByOther(db, { ...BASE, lockId: null });
    const sql = sqlOf(queryRaw.mock.calls[0]);
    expect(sql).toContain(`make_interval(secs => {${GRACE_SEC}}::double precision)`);
    expect(sql).toContain(`make_interval(secs => {${IDLE_SEC}}::double precision)`);

    // 純関数側: 同じ秒数を使って、expiryCause がその境界ちょうどで切り替わることを確かめる。
    // (SQL は `<`、expiryCause は `差分 > 上限` なので、境界の等号側は両方とも「期限切れではない」で揃う)
    const base: EditLockRow = {
      id: "l1",
      userId: "u",
      screenTokenHash: "h",
      acquiredAt: new Date(0),
      forceReleasedAt: null,
      heartbeatAt: new Date(0),
      activityAt: new Date(0),
    };
    const now = new Date(0);
    const justInsideHeartbeat = new Date(now.getTime() - GRACE_SEC * 1000);
    const justOutsideHeartbeat = new Date(now.getTime() - GRACE_SEC * 1000 - 1);
    expect(expiryCause({ ...base, heartbeatAt: justInsideHeartbeat, activityAt: now }, now)).toBeNull();
    expect(expiryCause({ ...base, heartbeatAt: justOutsideHeartbeat, activityAt: now }, now)).toBe("heartbeat");

    const justInsideIdle = new Date(now.getTime() - IDLE_SEC * 1000);
    const justOutsideIdle = new Date(now.getTime() - IDLE_SEC * 1000 - 1);
    expect(expiryCause({ ...base, heartbeatAt: now, activityAt: justInsideIdle }, now)).toBeNull();
    expect(expiryCause({ ...base, heartbeatAt: now, activityAt: justOutsideIdle }, now)).toBe("idle");
  });
});
