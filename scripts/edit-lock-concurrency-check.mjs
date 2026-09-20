/**
 * 手動確認スクリプト: 編集中の鍵(edit_locks)の SQL を実DBで確かめる。
 *
 * CI には postgres が無く、この branch(edit-lock-stage1)の SQL は一度も
 * 実際に実行されたことが無い。本番投入前に、開発DBに対して**1回**手で
 * 走らせて下のチェックリストを潰し、出力を PR に貼る。
 *
 * 使い方:
 *   npx dotenv -e .env -- node scripts/edit-lock-concurrency-check.mjs <物件のUUID>
 *
 * ⚠この repo は Prisma 7 の driver adapter 構成(src/lib/prisma.ts と同じ形)。
 *   アダプタを渡さないとクライアントの初期化で落ちる(@codex R10 P2)。
 *
 * ── 手順(番号どおりに実行し、出力を PR に貼る) ────────────────────────────
 *
 * 1. マイグレーションを実DBに当てる。
 *      コマンド: npx dotenv -e .env -- npx prisma migrate deploy
 *      期待する出力: `20260918100000_add_edit_locks` が Applied になり、
 *        エラー無く終わる(`edit_locks` テーブルと `EditLockResource` enum が
 *        作られる)。使い捨てできる開発DBなら `npx prisma migrate dev` でも可。
 *
 * 2. users テーブルに最低2行あることを確認する(無ければ `npm run db:seed` 等で作る)。
 *      このスクリプト自身が起動時に自動チェックし、2件未満ならエラー終了する。
 *
 * 3. 物件(properties)を1件用意し、その UUID を引数にこのスクリプトを実行する。
 *      コマンド: npx dotenv -e .env -- node scripts/edit-lock-concurrency-check.mjs <物件のUUID>
 *      期待する出力(要旨。実際は番号付きで詳細に出る):
 *        [1] 取得できた本数: 1 (1 なら正しい)
 *        [2] ON CONFLICT の make_interval 分岐: 通過(もう1本は held になった)
 *        [3] unnest ベースの IN(readEditLocks 相当): 1件読めた
 *        [4] unnest ベースの IN(deleteEditLocksFor 相当): 1件消せた
 *        [5] ::"EditLockResource" キャスト: 例外なし
 *        [6] 期限切れ横取りの競合再現: 再現した/しなかった のどちらか
 *            (**この行は再現有無に関わらず必ず PR に貼る**。記録すること自体が目的)
 *
 * ── このスクリプトがカバーする項目(Task 8 レビュー観点との対応) ───────────
 *   (a) 手書きマイグレーションの実DB適用          → 手順1
 *   (b) make_interval(secs => N::double precision) の実行 → [1][2]
 *       (2本目の同時取得が INSERT ... ON CONFLICT ... WHERE 節の
 *        make_interval 比較を実地で通る)
 *   (c) unnest(...) で組んだ行単位の IN(readEditLocks/deleteEditLocksFor) → [3][4]
 *   (d) ::"EditLockResource" enum キャスト        → [1]〜[4] すべてで踏む
 *   (e) acquireEditLock の pre-SELECT とその後の upsert が別文であることに
 *       起因する、期限切れ横取り時に takeover が null になり得る競合の再現 → [6]
 *
 * ⚠[1][2][6] は src/lib/edit-lock/service.ts の acquireEditLock、[3]は
 *   readEditLocks、[4]は deleteEditLocksFor と**同じ形の SQL をこのファイルに
 *   直接書いている**(このファイルは素の Node で動かす .mjs であり、
 *   TypeScript の service.ts を直接 import できないため)。service.ts 側の
 *   SQL の形(WHERE 節・キャスト・カラム名)を変えたら、ここも合わせて直すこと。
 */
import { PrismaClient } from "../src/generated/prisma/index.js";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg(process.env.DATABASE_URL);
const prisma = new PrismaClient({ adapter });

const resourceId = process.argv[2];
if (!resourceId) {
  console.error("使い方: node scripts/edit-lock-concurrency-check.mjs <物件のUUID>");
  process.exit(1);
}

// rules.ts の EDIT_LOCK_HEARTBEAT_GRACE_MS / EDIT_LOCK_IDLE_LIMIT_MS と同じ秒数。
const GRACE_SEC = 300;
const IDLE_SEC = 3600;

// service.ts の acquireEditLock の INSERT ... ON CONFLICT と同じ形。
const acquire = (userId, hash) => prisma.$queryRaw`
  INSERT INTO "edit_locks" ("id","resource_type","resource_id","user_id","screen_token_hash","acquired_at","heartbeat_at","activity_at")
  VALUES (gen_random_uuid(), 'property'::"EditLockResource", ${resourceId}::uuid, ${userId}::uuid, ${hash}, clock_timestamp(), clock_timestamp(), clock_timestamp())
  ON CONFLICT ("resource_type","resource_id") DO UPDATE
  SET "id" = gen_random_uuid(), "user_id" = EXCLUDED."user_id", "screen_token_hash" = EXCLUDED."screen_token_hash",
      "acquired_at" = clock_timestamp(), "heartbeat_at" = clock_timestamp(), "activity_at" = clock_timestamp(),
      "force_released_at" = NULL, "force_released_by" = NULL
  WHERE "edit_locks"."force_released_at" IS NOT NULL
     OR "edit_locks"."heartbeat_at" < clock_timestamp() - make_interval(secs => ${GRACE_SEC}::double precision)
     OR "edit_locks"."activity_at" < clock_timestamp() - make_interval(secs => ${IDLE_SEC}::double precision)
     OR ("edit_locks"."user_id" = EXCLUDED."user_id" AND "edit_locks"."screen_token_hash" = EXCLUDED."screen_token_hash")
  RETURNING "id"
`;

// service.ts の acquireEditLock の pre-SELECT と同じ形(横取り情報の判定用)。
async function takeoverAttempt(userId, hash) {
  const prevRows = await prisma.$queryRaw`
    SELECT "user_id", "screen_token_hash",
           CASE
             WHEN "heartbeat_at" < clock_timestamp() - make_interval(secs => ${GRACE_SEC}::double precision) THEN 'heartbeat'
             WHEN "activity_at" < clock_timestamp() - make_interval(secs => ${IDLE_SEC}::double precision) THEN 'idle'
             ELSE NULL
           END AS expired_by
    FROM "edit_locks"
    WHERE "resource_type" = 'property'::"EditLockResource" AND "resource_id" = ${resourceId}::uuid
      AND "force_released_at" IS NULL
  `;
  const prev = prevRows[0] ?? null;
  const got = await acquire(userId, hash);
  if (got.length === 0) return { won: false, takeover: null };
  const sameScreen = prev && prev.user_id === userId && prev.screen_token_hash === hash;
  const takeover =
    prev && prev.expired_by && !sameScreen
      ? { previousUserId: prev.user_id, expiredBy: prev.expired_by }
      : null;
  return { won: true, takeover };
}

async function main() {
  const users = await prisma.user.findMany({ take: 2, select: { id: true } });
  if (users.length < 2) {
    console.error(`users が2件未満です(${users.length}件)。先に2ユーザー以上 seed してください。`);
    process.exit(1);
  }
  const [u1, u2] = users;

  await prisma.$executeRaw`DELETE FROM "edit_locks" WHERE "resource_id" = ${resourceId}::uuid`;

  // [1][2] 同時取得は1本だけ通る。ON CONFLICT ... WHERE 節の make_interval 比較を
  //        実地で踏む(片方は既存行に conflict し、WHERE を評価するため)。
  const [a, b] = await Promise.all([acquire(u1.id, "screen-a"), acquire(u2.id, "screen-b")]);
  const wonCount = [a, b].filter((r) => r.length > 0).length;
  console.log(`[1] 取得できた本数: ${wonCount} (1 なら正しい)`);
  console.log(
    `[2] ON CONFLICT の make_interval 分岐: ${
      wonCount === 1 ? "通過(もう1本は held になった)" : "確認できず(想定外の結果。手動で再実行してください)"
    }`,
  );

  // [3] readEditLocks 相当: unnest ベースの行単位 IN + db_now を1クエリで読む。
  const readRows = await prisma.$queryRaw`
    SELECT clock_timestamp() AS db_now,
           "id", "resource_type", "resource_id", "user_id", "screen_token_hash",
           "acquired_at", "heartbeat_at", "activity_at", "force_released_at"
    FROM "edit_locks"
    WHERE ("resource_type"::text, "resource_id"::text) IN (
      SELECT * FROM unnest(${["property"]}::text[], ${[resourceId]}::text[])
    )
  `;
  console.log(`[3] unnest ベースの IN(readEditLocks 相当): ${readRows.length}件読めた`);

  // [4] deleteEditLocksFor 相当: 同じ unnest ベースの行単位 IN で削除する。
  const deletedRows = await prisma.$queryRaw`
    DELETE FROM "edit_locks"
    WHERE ("resource_type"::text, "resource_id"::text) IN (
      SELECT * FROM unnest(${["property"]}::text[], ${[resourceId]}::text[])
    )
    RETURNING "id"
  `;
  console.log(`[4] unnest ベースの IN(deleteEditLocksFor 相当): ${deletedRows.length}件消せた`);
  console.log(`[5] ::"EditLockResource" キャスト: 例外なし(ここまで到達していれば全クエリが通過済み)`);

  // [6] 期限切れの横取りで pre-SELECT と upsert(2文)の間に競合が起きないかを再現する。
  //     まず遥か過去のheartbeat/activityを持つ「期限切れの鍵」を u1 で作る。
  //     その後、2本の「pre-SELECT → INSERT」(takeoverAttempt)を同時に走らせる。
  //     片方は u1 の別タブ(同じ利用者・別画面=横取り扱い)、もう片方は u2。
  await prisma.$executeRaw`DELETE FROM "edit_locks" WHERE "resource_id" = ${resourceId}::uuid`;
  await prisma.$executeRaw`
    INSERT INTO "edit_locks" ("id","resource_type","resource_id","user_id","screen_token_hash","acquired_at","heartbeat_at","activity_at")
    VALUES (
      gen_random_uuid(), 'property'::"EditLockResource", ${resourceId}::uuid, ${u1.id}::uuid, 'stale-screen',
      clock_timestamp() - make_interval(secs => 999999::double precision),
      clock_timestamp() - make_interval(secs => 999999::double precision),
      clock_timestamp() - make_interval(secs => 999999::double precision)
    )
  `;

  const [r1, r2] = await Promise.all([
    takeoverAttempt(u1.id, "takeover-x"),
    takeoverAttempt(u2.id, "takeover-y"),
  ]);
  const winners = [r1, r2].filter((r) => r.won);
  const nullTakeoverAmongWinners = winners.filter((r) => r.takeover === null);
  console.log("[6] 期限切れ横取りの競合再現(生データ):", JSON.stringify({ r1, r2 }));
  if (winners.length === 1 && nullTakeoverAmongWinners.length === 1) {
    console.log("[6] 結果: 再現した(勝った方の takeover が null = 監査に横取りとして残らない可能性がある)");
  } else if (winners.length === 1) {
    console.log("[6] 結果: 再現しなかった(勝った方の takeover は正しく記録された)");
  } else {
    console.log("[6] 結果: 判定不能(想定外: 勝者が0本または2本)。手動で再実行してください");
  }

  await prisma.$executeRaw`DELETE FROM "edit_locks" WHERE "resource_id" = ${resourceId}::uuid`;
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
