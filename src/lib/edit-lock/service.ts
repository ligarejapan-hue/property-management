/**
 * 編集中の鍵の台帳(edit_locks)への読み書き。SQL はこのファイルだけに置く。
 *
 * ⚠期限の判定は **DB の時刻**が権威。JS の時刻は使わない。
 * ⚠`now()` はトランザクション開始時刻で固定されるため、**`clock_timestamp()`** を使う(@codex R12 P2)。
 * ⚠取得・保存の確認・管理者解除は、呼び出し側が**先に資源の行をロック**してから
 *   呼ぶ(ロック順序 = 所有者 → 物件の親行 → 子行)。合図だけはロックしない。
 *
 * 分類(表示用の "free"/"mine"/"held_by_other" 等・lost/taken)の置き場所は1つに絞る:
 *   - **原子性が要る門は SQL で判定する**(acquireEditLock の ON CONFLICT ... WHERE、
 *     heartbeatEditLock の UPDATE ... WHERE、assertNotEditLockedByOther、isResourceEditLocked)。
 *     これらは「今まさに書き込んでよいか」を DB の行と同じタイミングで決めないと壊れる。
 *   - **それ以外(表示・状態通知)は純関数 `evaluateLock` に任せる**。SQL は生の行と
 *     `clock_timestamp() AS db_now` を返すだけにして、呼び出し側が `evaluateLock(lock, dbNow, requester)`
 *     で判定する。DB 由来の "now" を渡す限り、JS 時計とのずれは起きない。
 */
import { ApiError } from "@/lib/api-helpers";
import {
  EDIT_LOCK_HEARTBEAT_GRACE_MS,
  EDIT_LOCK_IDLE_LIMIT_MS,
  type EditLockResourceType,
  type EditLockRow,
} from "./rules";

export type Db = {
  $queryRaw: <T>(q: TemplateStringsArray, ...v: unknown[]) => Promise<T>;
};

type RawRow = {
  id: string;
  user_id: string;
  screen_token_hash: string;
  acquired_at: Date;
  heartbeat_at: Date;
  activity_at: Date;
  force_released_at: Date | null;
};

// SQL の make_interval に渡す秒数。rules.ts の定数から導く(手で決め打ちしない)。
// コントローラ決定②: この2つの定数から導いた値が SQL 文字列に現れることをテストで固定している
// (src/lib/edit-lock/__tests__/service.test.ts「SQL の期限しきい値と rules.ts の一致」)。
// ⚠`make_interval(secs => ${GRACE_SEC})` は Prisma が整数値の JS number を integer 型で
//   bind するため、make_interval の `secs`(double precision)とパラメータ型が食い違い、
//   実行時(本番 DB)にしか出ないエラーになる(CI に DB が無く検出できない)。
//   全ての利用箇所で `${GRACE_SEC}::double precision` のように明示キャストする。
const GRACE_SEC = EDIT_LOCK_HEARTBEAT_GRACE_MS / 1000;
const IDLE_SEC = EDIT_LOCK_IDLE_LIMIT_MS / 1000;

function toRow(r: RawRow): EditLockRow {
  return {
    id: r.id,
    userId: r.user_id,
    screenTokenHash: r.screen_token_hash,
    acquiredAt: r.acquired_at,
    heartbeatAt: r.heartbeat_at,
    activityAt: r.activity_at,
    forceReleasedAt: r.force_released_at,
  };
}

export type Target = { resourceType: EditLockResourceType; resourceId: string };
export type Holder = { userId: string; screenTokenHash: string };

async function readOne(db: Db, t: Target): Promise<EditLockRow | null> {
  const rows = await db.$queryRaw<RawRow[]>`
    SELECT "id", "user_id", "screen_token_hash", "acquired_at", "heartbeat_at", "activity_at", "force_released_at"
    FROM "edit_locks"
    WHERE "resource_type" = ${t.resourceType}::"EditLockResource" AND "resource_id" = ${t.resourceId}::uuid
  `;
  return rows[0] ? toRow(rows[0]) : null;
}

export async function acquireEditLock(
  db: Db,
  input: Target & Holder,
): Promise<
  | {
      state: "mine";
      lockId: string;
      since: Date;
      /** 期限切れの鍵を横取りしたときだけ入る(判定は DB の now()・@codex R8 P2)。 */
      takeover: { previousUserId: string; expiredBy: "heartbeat" | "idle" } | null;
    }
  | { state: "held"; current: EditLockRow }
> {
  // ⚠横取りの判定は**DBの now()** で行う(@codex R8 P2)。取得のSQLと同じ基準にそろえる。
  const prevRows = await db.$queryRaw<{ user_id: string; screen_token_hash: string; expired_by: "heartbeat" | "idle" | null }[]>`
    SELECT "user_id", "screen_token_hash",
           CASE
             WHEN "heartbeat_at" < clock_timestamp() - make_interval(secs => ${GRACE_SEC}::double precision) THEN 'heartbeat'
             WHEN "activity_at" < clock_timestamp() - make_interval(secs => ${IDLE_SEC}::double precision) THEN 'idle'
             ELSE NULL
           END AS expired_by
    FROM "edit_locks"
    WHERE "resource_type" = ${input.resourceType}::"EditLockResource" AND "resource_id" = ${input.resourceId}::uuid
      AND "force_released_at" IS NULL
  `;
  const prev = prevRows[0] ?? null;
  const got = await db.$queryRaw<{ id: string; acquired_at: Date }[]>`
    INSERT INTO "edit_locks" ("id", "resource_type", "resource_id", "user_id", "screen_token_hash", "acquired_at", "heartbeat_at", "activity_at")
    VALUES (gen_random_uuid(), ${input.resourceType}::"EditLockResource", ${input.resourceId}::uuid, ${input.userId}::uuid, ${input.screenTokenHash}, clock_timestamp(), clock_timestamp(), clock_timestamp())
    ON CONFLICT ("resource_type", "resource_id") DO UPDATE
    SET "id" = gen_random_uuid(),
        "user_id" = EXCLUDED."user_id",
        "screen_token_hash" = EXCLUDED."screen_token_hash",
        "acquired_at" = clock_timestamp(),
        "heartbeat_at" = clock_timestamp(),
        "activity_at" = clock_timestamp(),
        "force_released_at" = NULL,
        "force_released_by" = NULL
    WHERE "edit_locks"."force_released_at" IS NOT NULL
       OR "edit_locks"."heartbeat_at" < clock_timestamp() - make_interval(secs => ${GRACE_SEC}::double precision)
       OR "edit_locks"."activity_at" < clock_timestamp() - make_interval(secs => ${IDLE_SEC}::double precision)
       OR ("edit_locks"."user_id" = EXCLUDED."user_id" AND "edit_locks"."screen_token_hash" = EXCLUDED."screen_token_hash")
    RETURNING "id", "acquired_at"
  `;
  if (got[0]) {
    // ⚠**同じ利用者の別タブでも横取りは横取り**(@codex R9 P2)。別タブは他人と同じ扱いにしているので、
    //   利用者IDだけで除外すると、その取得が通常の取得として記録され、期限切れの原因も残らない。
    //   自分の同じ画面の取り直し(同じ合言葉)は、そもそも期限切れでなければ expired_by が null になる。
    const sameScreen =
      prev && prev.user_id === input.userId && prev.screen_token_hash === input.screenTokenHash;
    const takeover =
      prev && prev.expired_by && !sameScreen
        ? { previousUserId: prev.user_id, expiredBy: prev.expired_by }
        : null;
    return { state: "mine", lockId: got[0].id, since: got[0].acquired_at, takeover };
  }
  const current = await readOne(db, input);
  // 取れず、かつ行も消えている = 直前に別の誰かが取って外した。もう一度取りにいかせる。
  if (!current) throw new ApiError(409, "鍵の状態が変わりました。もう一度お試しください", "EDIT_LOCK_CHANGED");
  return { state: "held", current };
}

export async function heartbeatEditLock(
  db: Db,
  input: Target & Holder & { active: boolean },
): Promise<{ ok: true } | { ok: false; dbNow: Date; current: EditLockRow | null }> {
  const updated = await db.$queryRaw<{ id: string }[]>`
    UPDATE "edit_locks"
    SET "heartbeat_at" = clock_timestamp(),
        "activity_at" = CASE WHEN ${input.active} THEN clock_timestamp() ELSE "activity_at" END
    WHERE "resource_type" = ${input.resourceType}::"EditLockResource"
      AND "resource_id" = ${input.resourceId}::uuid
      AND "user_id" = ${input.userId}::uuid
      AND "screen_token_hash" = ${input.screenTokenHash}
      AND "force_released_at" IS NULL
      AND "heartbeat_at" >= clock_timestamp() - make_interval(secs => ${GRACE_SEC}::double precision)
      AND "activity_at" >= clock_timestamp() - make_interval(secs => ${IDLE_SEC}::double precision)
    RETURNING "id"
  `;
  if (updated[0]) return { ok: true };
  // ⚠状態の判定は DB に任せる(@codex R9 P2)。アプリの時計で期限を測り直すと、
  //   5分・60分の境目で「生きている他人の鍵を期限切れと報告」して余計な取り直しを起こす。
  //   呼び出し側は返ってきた dbNow を使って evaluateLock で判定すること(自前の now() を使わない)。
  const { dbNow, rows } = await readRawWithDbNow(db, [input]);
  return { ok: false, dbNow, current: rows[0] ? toRow(rows[0]) : null };
}

export async function releaseEditLock(
  db: Db,
  input: Target & Holder & { lockId: string },
): Promise<{ deleted: number }> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    DELETE FROM "edit_locks"
    WHERE "id" = ${input.lockId}::uuid
      AND "resource_type" = ${input.resourceType}::"EditLockResource"
      AND "resource_id" = ${input.resourceId}::uuid
      AND "user_id" = ${input.userId}::uuid
      AND "screen_token_hash" = ${input.screenTokenHash}
      AND "force_released_at" IS NULL
    RETURNING "id"
  `;
  return { deleted: rows.length };
}

export async function forceReleaseEditLock(
  db: Db,
  input: Target & { lockId: string; adminUserId: string },
): Promise<{ previousUserId: string } | null> {
  const rows = await db.$queryRaw<{ user_id: string }[]>`
    UPDATE "edit_locks"
    SET "force_released_at" = clock_timestamp(), "force_released_by" = ${input.adminUserId}::uuid
    WHERE "id" = ${input.lockId}::uuid
      AND "resource_type" = ${input.resourceType}::"EditLockResource"
      AND "resource_id" = ${input.resourceId}::uuid
      AND "force_released_at" IS NULL
    RETURNING "user_id"
  `;
  return rows[0] ? { previousUserId: rows[0].user_id } : null;
}

/**
 * 生の行を `clock_timestamp() AS db_now` と一緒に読む唯一の入口。
 * ⚠ここでは active/force_released を SQL 側で計算しない(表示・状態通知は `evaluateLock` に任せる方針)。
 * `readEditLocks` と `heartbeatEditLock` の失敗時読み取りが、この1つのヘルパを共有する。
 */
async function readRawWithDbNow(
  db: Db,
  resources: Target[],
): Promise<{ dbNow: Date; rows: (RawRow & { resource_type: EditLockResourceType; resource_id: string })[] }> {
  if (resources.length === 0) {
    // 該当する資源が無いので判定に使う行も無い。dbNow はどのみち使われない。
    return { dbNow: new Date(), rows: [] };
  }
  const types = resources.map((r) => r.resourceType);
  const ids = resources.map((r) => r.resourceId);
  const rows = await db.$queryRaw<
    (RawRow & { resource_type: EditLockResourceType; resource_id: string; db_now: Date })[]
  >`
    SELECT clock_timestamp() AS db_now,
           "id", "resource_type", "resource_id", "user_id", "screen_token_hash",
           "acquired_at", "heartbeat_at", "activity_at", "force_released_at"
    FROM "edit_locks"
    -- ⚠列側を ::text へ落とさない(review Minor 7)。"resource_id" は uuid 列なので、
    --   unnest 側を "resource_type"/"resource_id" と同じ型(enum/uuid)にキャストして
    --   ネイティブ型どうしで比較する。列側を text にキャストすると、大文字混じりの
    --   UUID(呼び出し元が URL のパス片をそのまま渡す経路がある)が uuid としては
    --   一致するのに text としては一致せず、鍵だけが消せずに残る
    --   (資源は消えたのに鍵が永久に外れない孤児になる)。
    WHERE ("resource_type", "resource_id") IN (
      SELECT t::"EditLockResource", i::uuid FROM unnest(${types}::text[], ${ids}::text[]) AS x(t, i)
    )
  `;
  // 該当する鍵が1件も無いときは db_now を積んだ行自体が無い。この場合も判定対象が無いので使われない。
  const dbNow = rows[0]?.db_now ?? new Date();
  return { dbNow, rows };
}

/**
 * 状態画面などが使う。分類はせず、生の行 + DB の今時刻を返す。
 * 呼び出し側が `evaluateLock(lock, dbNow, requester)` で "free"/"mine"/"held_by_other" 等を決める。
 */
export async function readEditLocks(
  db: Db,
  resources: Target[],
): Promise<{ dbNow: Date; locks: (EditLockRow & Target)[] }> {
  const { dbNow, rows } = await readRawWithDbNow(db, resources);
  return {
    dbNow,
    locks: rows.map((r) => ({ ...toRow(r), resourceType: r.resource_type, resourceId: r.resource_id })),
  };
}

/**
 * 保持者を持たない処理(取込など)が使う。「今、誰かが編集中か」だけを DB の now() で判定する。
 * ここは原子性が要る門ではないが、判定基準(しきい値)は他の門と揃える。
 */
export async function isResourceEditLocked(db: Db, target: Target): Promise<boolean> {
  const rows = await db.$queryRaw<{ locked: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM "edit_locks"
      WHERE "resource_type" = ${target.resourceType}::"EditLockResource"
        AND "resource_id" = ${target.resourceId}::uuid
        AND "force_released_at" IS NULL
        AND "heartbeat_at" >= clock_timestamp() - make_interval(secs => ${GRACE_SEC}::double precision)
        AND "activity_at" >= clock_timestamp() - make_interval(secs => ${IDLE_SEC}::double precision)
    ) AS locked
  `;
  return rows[0]?.locked ?? false;
}

/**
 * 保存の窓口で呼ぶ。**資源の行をロックした後・書き込みの前**に。
 * 合言葉が無い(反映前から開いていた古い画面)ときは、断る文言に再読み込みの案内を足す。
 */
export async function assertNotEditLockedByOther(
  db: Db,
  input: Target & {
    userId: string;
    screenTokenHash: string | null;
    /**
     * 編集ウィンドウ/所有者カードが持っている鍵の世代(取得の応答の lockId)。
     * ⚠**世代を持って来た保存は、その世代が今の鍵と一致するときだけ通す**(@codex R8 P1)。
     *   管理者が外した後に別の人が取って外すと墓標が消えるため、墓標だけでは
     *   「外された画面からの遅れた保存」を止めきれない。世代で見ればいつでも止まる。
     * プルダウンや地番ポップアップのように鍵を持たない入口は null。
     * ⚠**必須(省略不可)**: Task 6 でこの関数を呼ぶ保存経路が複数あるため、省略可能にすると
     *   呼び出し側が渡し忘れても型上は通ってしまい、世代チェックが黙って外れる
     *   (この引数がまさに塞ぎたい抜け穴)。呼び出し側に必ず `null` か実値かを明示させる。
     */
    lockId: string | null;
  },
): Promise<void> {
  // ⚠期限の判定は **DB の now()** で行う(@codex R6 P2)。取得・合図が DB 時計を権威に
  //   しているのに、ここだけアプリの時計で判定すると、5分の境目で食い違って
  //   「生きている鍵を期限切れとみなして書き込む」ことが起きる。
  const rows = await db.$queryRaw<{ id: string; user_id: string; screen_token_hash: string; force_released: boolean; active: boolean }[]>`
    SELECT "id", "user_id", "screen_token_hash",
           ("force_released_at" IS NOT NULL) AS force_released,
           ("force_released_at" IS NULL
            AND "heartbeat_at" >= clock_timestamp() - make_interval(secs => ${GRACE_SEC}::double precision)
            AND "activity_at" >= clock_timestamp() - make_interval(secs => ${IDLE_SEC}::double precision)) AS active
    FROM "edit_locks"
    WHERE "resource_type" = ${input.resourceType}::"EditLockResource" AND "resource_id" = ${input.resourceId}::uuid
  `;
  const row = rows[0];
  const sameHolder =
    !!row && row.user_id === input.userId && row.screen_token_hash === (input.screenTokenHash ?? "");

  // ⚠**順番が大事**(@codex R9 P2): 墓標の行は active が false なので、世代の検査を先に置くと
  //   管理者に外された人にまで「鍵が外れています(EDIT_LOCK_STALE)」を返してしまい、
  //   約束した「管理者が編集を終了しました」の文言が出なくなる。**墓標を先に見る**。
  if (row && row.force_released && sameHolder) {
    throw new ApiError(423, "管理者が編集を終了しました。この内容は保存できません", "EDIT_LOCK_FORCE_RELEASED");
  }
  // 世代を持って来た保存(=編集ウィンドウ/所有者カード)は、その世代が今も生きているときだけ通す。
  if (input.lockId) {
    // ⚠**世代だけでは足りない**(@codex R11 P2)。世代は状態の窓口から管理者に見えるので、
    //   他の画面の世代を貼り付けて保存できてしまう。保持者(利用者+合言葉)の一致も必須にする。
    const stillMine = row && row.id === input.lockId && row.active && sameHolder;
    if (!stillMine) {
      throw new ApiError(423, "編集の鍵が外れています。画面を開き直してください", "EDIT_LOCK_STALE");
    }
  }
  if (!row) return;
  const state = { state: !row.active ? "free" : sameHolder ? "mine" : "held" } as const;
  if (state.state === "held") {
    const suffix = input.screenTokenHash ? "" : "。画面を再読み込みしてください";
    throw new ApiError(423, `他の画面で編集中です${suffix}`, "EDIT_LOCKED");
  }
}

/** 資源を消す/アーカイブするときの後始末。 */
export async function deleteEditLocksFor(db: Db, resources: Target[]): Promise<number> {
  if (resources.length === 0) return 0;
  const types = resources.map((r) => r.resourceType);
  const ids = resources.map((r) => r.resourceId);
  const rows = await db.$queryRaw<{ id: string }[]>`
    DELETE FROM "edit_locks"
    -- ⚠readRawWithDbNow と同じ理由(review Minor 7)で列側を text に落とさない。
    --   uuid の大文字/小文字違いでも消せなければ、資源が消えたのに鍵だけ
    --   永久に残る(誰にも外せない)孤児になる。
    WHERE ("resource_type", "resource_id") IN (
      SELECT t::"EditLockResource", i::uuid FROM unnest(${types}::text[], ${ids}::text[]) AS x(t, i)
    )
    RETURNING "id"
  `;
  return rows.length;
}
