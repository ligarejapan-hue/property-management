/**
 * 手動確認スクリプト: 編集中の鍵(edit_locks)の SQL を実DBで確かめる。
 *
 * CI には postgres が無く、この branch(edit-lock-stage1)の SQL は一度も
 * 実際に実行されたことが無い。本番投入前に、開発DBに対して**1回**手で
 * 走らせて下のチェックリストを潰し、出力を PR に貼る。
 *
 * 使い方(review Important 3: この repo に `dotenv-cli` は無い。ライブラリの
 * `dotenv` はあるが bin を持たないため `npx dotenv -e .env -- …` は
 * "could not determine executable to run" で即死する。Node 24 が本番ランタイム
 * なので `--env-file` を使う):
 *   node --env-file=.env scripts/edit-lock-concurrency-check.mjs <物件のUUID> --i-know-this-writes
 *
 * ⚠**このスクリプトは実際に DELETE/INSERT する**(review Minor 9)。指定した物件の
 *   edit_locks 行を消して作り直すため、`--i-know-this-writes` を明示しない限り、
 *   接続先を表示するだけで**何もせず**終了する。事故で本番に対して実行できないように
 *   するための belt-and-braces。DATABASE_URL が空の場合も即エラー終了する
 *   (空のまま `new PrismaPg(undefined)` を作ると pg 自身の既定値に静かにフォール
 *   バックし、意図しない DB に「成功」してしまうため)。
 *
 * ⚠この repo は Prisma 7 の driver adapter 構成(src/lib/prisma.ts と同じ形)。
 *   アダプタを渡さないとクライアントの初期化で落ちる(@codex R10 P2)。
 *
 * ⚠**デプロイ順序(review Minor 11・M5で影響範囲を訂正)**: `deleteEditLocksFor` や
 *   `assertNotEditLockedByOther` は edit_locks への生SQLなので、このコードを
 *   migration(`20260918100000_add_edit_locks`)適用より前にデプロイすると、
 *   `relation "edit_locks" does not exist` で 500 になる。**影響範囲は物件削除・
 *   所有者アーカイブ・所有者統合・取込ロールバックの4経路だけではない**
 *   (以前のこの注記はそう書いていたが過小だった=H6): `assertNotEditLockedByOther` は
 *   `PATCH /api/properties/[id]`・`PATCH /api/owners/[id]`・
 *   `POST /api/owners/[id]/corporate-apply` の**全保存**で必ず走るため、
 *   **物件の保存・所有者の保存・法人番号の反映・取込のすべてが500になる**
 *   (fail-closed なので、資源だけ消えて鍵が孤児になるより安全な倒れ方ではあるが、
 *   機能停止には変わらない)。**必ず「migration 適用 → アプリの再起動」の順で
 *   行うこと**(脚注ではなくデプロイ手順の必須ステップとして扱う。計画の
 *   デプロイ手順章・仕様9.2にも同じ順序を明記する)。
 *
 * ── 手順(番号どおりに実行し、出力を PR に貼る) ────────────────────────────
 *
 * 1. マイグレーションを実DBに当てる。
 *      コマンド: npx prisma migrate deploy
 *      (Prisma CLI は自分で `.env` を読むので dotenv 系のラッパーは不要)
 *      期待する出力: `20260918100000_add_edit_locks` が Applied になり、
 *        エラー無く終わる(`edit_locks` テーブルと `EditLockResource` enum が
 *        作られる)。使い捨てできる開発DBなら `npx prisma migrate dev` でも可。
 *
 * 2. users テーブルに最低2行、properties テーブルに最低2行あることを確認する
 *      (無ければ `npm run db:seed` 等で作る)。このスクリプト自身が起動時に
 *      自動チェックし、不足していれば該当するチェックだけ非致命的にスキップする
 *      (users 不足は全体を中断、properties 不足は [7] だけスキップ)。
 *
 * 3. このスクリプトを実行する:
 *      node --env-file=.env scripts/edit-lock-concurrency-check.mjs <物件のUUID> --i-know-this-writes
 *      期待する出力(要旨。実際は番号付きで詳細に出る):
 *        [1] 取得できた本数: 1 (1 なら正しい。それ以外は非0で終了する)
 *        [2] ON CONFLICT の make_interval 分岐: 通過(もう1本は held になった)
 *        [3] unnest ベースの IN(readEditLocks 相当): 渡した表記・大文字化・小文字化の
 *            3種類とも1件読めて一致(item Fの実地確認。ずれれば非0で終了する)
 *        [4] unnest ベースの IN(deleteEditLocksFor 相当): 1件消せた(1件でなければ非0で終了する)
 *        [5] ::"EditLockResource" キャスト: 例外なし
 *        [6] 種の位置(境界のどちら側から始めたか)と、期限切れ横取りの競合再現:
 *            「N回中M回で再現した」/「N回の試行では再現しなかった」のどちらか
 *            (**この行は結果に関わらず必ず PR に貼る**。記録すること自体が目的)
 *        [7] rollback route と同じ ANY(::uuid[]) ORDER BY id FOR UPDATE: 2件ロックできた
 *            (properties が2件未満なら非致命的にスキップし、その旨を出力する)
 *        [8] assertNotEditLockedByOther 相当: active/force_released が型エラー無く
 *            boolean で返る(自分視点 true/false、他人視点も行は読める)
 *        [9] heartbeatEditLock 相当: active=true/false の両分岐が1件ずつ更新でき、
 *            他人の合図は0件で弾かれる(boolean パラメータ推論 + timestamptz/timestamp
 *            の CASE 型解決が実DBで通ることの確認。CIでは絶対に踏めない)
 *        [10] forceReleaseEditLock 相当: 1回目は1件・二重解除は0件
 *        [11] isResourceEditLocked 相当: 墓標後は false・生きた鍵は true
 *
 * ── このスクリプトがカバーする項目(Task 8 レビュー観点との対応) ───────────
 *   (a) 手書きマイグレーションの実DB適用          → 手順1
 *   (b) make_interval(secs => N::double precision) の実行 → [1][2]
 *       (2本目の同時取得が INSERT ... ON CONFLICT ... WHERE 節の
 *        make_interval 比較を実地で通る)
 *   (c) unnest(...) で組んだ行単位の IN(readEditLocks/deleteEditLocksFor) → [3][4]
 *       (review round2 Minor 2 / round3 Minor 1: [3] は渡された表記・大文字化・
 *        小文字化の3種類を読み、件数が一致し期待の1件であることまで比較する。
 *        argv をそのまま使うだけでは、operator がたまたま大文字UUIDを渡さない限り
 *        item F の実地確認にならず、渡した表記と大文字化の2種類だけの比較でも
 *        operator が最初から大文字を渡すと同じ文字列同士の比較になり無意味だった)
 *   (d) ::"EditLockResource" enum キャスト        → [1]〜[4][7] すべてで踏む
 *   (e) acquireEditLock の pre-SELECT とその後の upsert が別文であることに
 *       起因する、期限切れ横取り時に takeover が null になり得る競合の再現 → [6]
 *       (review Important 2: 期限ぎりぎりで複数回試行し、再現回数を報告する。
 *        1回きりの「再現しなかった」を確定回答として扱わない)
 *   (g) この task が新規に書いた唯一の SQL
 *       (`rollback/route.ts` の `ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`)の実行
 *       → [7](review Important 1。配列バインド + text[]→uuid[] キャストは
 *       `make_interval` の integer/double precision 食い違いと同じ「実行するまで
 *       わからない」種類の失敗であり、CI・order test(`$queryRaw` はモック)の
 *       どちらでも検出できない)
 *   (h) assertNotEditLockedByOther(物件・所有者の**全保存**+corporate-apply で
 *       毎回走る)の実行 → [8](review Important 6=H6。この文の bind/型解決の
 *       食い違いは、これまで一度も実DBで踏まれたことが無かった)
 *   (i) heartbeatEditLock の CASE 分岐(boolean パラメータ推論 +
 *       timestamptz/timestamp の型解決)の実行 → [9](H6。CIでは絶対に踏めない
 *       種類の失敗)
 *   (j) forceReleaseEditLock(世代+資源一致で墓標を立てる/二重解除は0件)の実行 → [10](H6)
 *   (k) isResourceEditLocked(墓標は編集中に数えない)の実行 → [11](H6)
 *
 * ⚠[1][2][6] は src/lib/edit-lock/service.ts の acquireEditLock、[3]は
 *   readEditLocks、[4]は deleteEditLocksFor、[7]は rollback/route.ts の
 *   バッチロックと**同じ形の SQL をこのファイルに直接書いている**(このファイルは
 *   素の Node で動かす .mjs であり、TypeScript の service.ts/route.ts を直接
 *   import できないため)。それぞれの SQL の形(WHERE 節・キャスト・カラム名)を
 *   変えたら、ここも合わせて直すこと。[8]は assertNotEditLockedByOther、[9]は
 *   heartbeatEditLock、[10]は forceReleaseEditLock、[11]は isResourceEditLocked
 *   と同じ形(同じ理由)。
 */
import { PrismaClient } from "../src/generated/prisma/index.js";
import { PrismaPg } from "@prisma/adapter-pg";

// ── ガード(review Important 3 / Minor 9 / Minor 8): 何かする前に必ず通す ──

if (!process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL が設定されていません。`.env` を用意し\n" +
      "  node --env-file=.env scripts/edit-lock-concurrency-check.mjs <物件のUUID> --i-know-this-writes\n" +
      "の形で実行してください(`npx dotenv -e .env -- …` はこの repo では動きません。dotenv-cli 未導入)。",
  );
  process.exit(1);
}

const USAGE =
  "使い方: node --env-file=.env scripts/edit-lock-concurrency-check.mjs <物件のUUID> --i-know-this-writes";
const KNOWN_FLAG = "--i-know-this-writes";

let dbHost = "(DATABASE_URL の形式が不正で判読できません)";
try {
  dbHost = new URL(process.env.DATABASE_URL).host;
} catch {
  // 表示できなくても致命的ではない。実際に不正なら PrismaPg の初期化で別途落ちる。
}
console.log(`接続先DB: ${dbHost}`);

const rawArgs = process.argv.slice(2);

// review round2 Minor 4: 単発ダッシュ(`-x`)は素通りし、未知の `--flag` は
// 黙って無視されていた。既知のフラグ以外の `-` 始まりの引数はすべて拒否する。
const unknownFlag = rawArgs.find((a) => a.startsWith("-") && a !== KNOWN_FLAG);
if (unknownFlag) {
  console.error(`不明な引数です: ${unknownFlag}\n${USAGE}`);
  process.exit(1);
}

// フラグを除いた最初の位置引数を物件のUUIDとして扱う。素朴に argv[2] を見ると、
// フラグだけ渡して物件UUIDを渡し忘れたときに `--i-know-this-writes` という
// 文字列そのものが「UUID」として扱われ、無効な DB へ本当に接続を試みてしまう。
const positionalArgs = rawArgs.filter((a) => a !== KNOWN_FLAG);
const resourceId = positionalArgs[0];
const hasOptIn = rawArgs.includes(KNOWN_FLAG);

if (!resourceId || !hasOptIn) {
  console.error(
    [
      USAGE,
      "",
      "このスクリプトは指定した物件の edit_locks 行を実際に DELETE/INSERT します。",
      "本番などの共有DBに対して誤実行しないよう、--i-know-this-writes を明示しない限り、",
      "上の接続先を表示するだけで何もせず終了します。",
    ].join("\n"),
  );
  process.exit(1);
}

const adapter = new PrismaPg(process.env.DATABASE_URL);
const prisma = new PrismaClient({ adapter });

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

// review round2 Important 1: 期限の**手前**(まだ生きている側)に種を蒔く。
// 前回は `- interval '2 milliseconds'`(期限を2ms過ぎた側)に種を蒔いていたため、
// pre-SELECT の時点で既に expired_by が確定してしまい、横取りの「非レース」経路
// (正しく記録される経路)しか通らなかった(reproducedCount が常に0になる)。
// バグが起きるのは「pre-SELECT はまだ生きていると見る → その直後の upsert の
// WHERE 評価までの間に境界をまたいで期限切れになる」場合だけなので、種は
// **期限のまだ手前**(+ offsetMs ミリ秒)に置き、DB往復のジッタで実際に
// 境界をまたぐ可能性を残す。offsetMs は 0〜7ms を周回させ(呼び出し側の
// `i % 8`)、ちょうど良い一点を運任せにしない。
async function seedNearExpiryLock(holderUserId, offsetMs) {
  await prisma.$executeRaw`DELETE FROM "edit_locks" WHERE "resource_id" = ${resourceId}::uuid`;
  await prisma.$executeRaw`
    INSERT INTO "edit_locks" ("id","resource_type","resource_id","user_id","screen_token_hash","acquired_at","heartbeat_at","activity_at")
    VALUES (
      gen_random_uuid(), 'property'::"EditLockResource", ${resourceId}::uuid, ${holderUserId}::uuid, 'stale-screen',
      clock_timestamp() - make_interval(secs => ${GRACE_SEC}::double precision) + (${offsetMs}::double precision * interval '1 millisecond'),
      clock_timestamp() - make_interval(secs => ${GRACE_SEC}::double precision) + (${offsetMs}::double precision * interval '1 millisecond'),
      clock_timestamp() - make_interval(secs => ${GRACE_SEC}::double precision) + (${offsetMs}::double precision * interval '1 millisecond')
    )
  `;
}

async function main() {
  // review Minor 8: 存在しない UUID を渡しても [1]〜[5] が「全部緑」に見えてしまう
  // (0件を「成功」と誤読できる)ことを防ぐ。
  const property = await prisma.property.findUnique({
    where: { id: resourceId },
    select: { id: true },
  });
  if (!property) {
    console.error(`指定した物件が見つかりません: ${resourceId}`);
    process.exitCode = 1;
    await prisma.$disconnect();
    return;
  }

  const users = await prisma.user.findMany({ take: 2, select: { id: true } });
  if (users.length < 2) {
    console.error(`users が2件未満です(${users.length}件)。先に2ユーザー以上 seed してください。`);
    process.exitCode = 1;
    await prisma.$disconnect();
    return;
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
  // review Minor 8: ゲートが 0 終了で「成功」を騙らないよう、想定外なら非0で終える。
  if (wonCount !== 1) process.exitCode = 1;

  // [3] readEditLocks 相当: unnest ベースの行単位 IN + db_now を1クエリで読む。
  //     service.ts と同じく列側は text へ落とさず、unnest 側を enum/uuid にキャストする
  //     (review Minor 7 の修理後の形)。
  //     review round2 Minor 2 / round3 Minor 1: argv をそのまま渡すだけでは、操作者が
  //     たまたま小文字UUIDを渡した回だけ「緑」に見えてしまい、item F(大文字UUIDの
  //     孤児鍵バグ)の実地確認になっていなかった。さらに、渡した表記と大文字化の
  //     2種類だけの比較は、操作者が**最初から大文字**の UUID を渡すと両者が同じ
  //     文字列になり、何の証明にもならないまま「一致」と出てしまう(round2版の
  //     見落とし)。渡した表記・大文字化・小文字化の**3種類**を読み、3つとも
  //     同じ件数(かつ期待値の1件)であることを比較する — これが item F を
  //     実DBで証明する唯一の手段。
  const readByResourceIdVariant = (idVariant) => prisma.$queryRaw`
    SELECT clock_timestamp() AS db_now,
           "id", "resource_type", "resource_id", "user_id", "screen_token_hash",
           "acquired_at", "heartbeat_at", "activity_at", "force_released_at"
    FROM "edit_locks"
    WHERE ("resource_type", "resource_id") IN (
      SELECT t::"EditLockResource", i::uuid FROM unnest(${["property"]}::text[], ${[idVariant]}::text[]) AS x(t, i)
    )
  `;
  const asGivenRows = await readByResourceIdVariant(resourceId);
  const upperRows = await readByResourceIdVariant(resourceId.toUpperCase());
  const lowerRows = await readByResourceIdVariant(resourceId.toLowerCase());
  const readCounts = { asGiven: asGivenRows.length, upper: upperRows.length, lower: lowerRows.length };
  console.log(
    `[3] 比較した表記: 渡した表記=${resourceId} / 大文字化=${resourceId.toUpperCase()} / ` +
      `小文字化=${resourceId.toLowerCase()}`,
  );
  console.log(
    `[3] 読めた件数: 渡した表記=${readCounts.asGiven}件 / 大文字化=${readCounts.upper}件 / ` +
      `小文字化=${readCounts.lower}件`,
  );
  const readOk =
    readCounts.asGiven === readCounts.upper &&
    readCounts.upper === readCounts.lower &&
    readCounts.asGiven === 1;
  console.log(
    `[3] 結果: ${
      readOk
        ? "3表記とも一致・1件(item Fが実DBで直っていることの証拠)"
        : "不一致、または1件ではない(要調査)"
    }`,
  );
  if (!readOk) process.exitCode = 1;

  // [4] deleteEditLocksFor 相当: 同じ unnest ベースの行単位 IN で削除する。
  // ⚠[3]と違って DELETE なので、渡された表記のまま1回だけ実行する
  //   (先に別の表記の変種で消してしまうと、[3]の比較対象が消える)。
  const deletedRows = await prisma.$queryRaw`
    DELETE FROM "edit_locks"
    WHERE ("resource_type", "resource_id") IN (
      SELECT t::"EditLockResource", i::uuid FROM unnest(${["property"]}::text[], ${[resourceId]}::text[]) AS x(t, i)
    )
    RETURNING "id"
  `;
  console.log(`[4] 消せた件数: ${deletedRows.length}件`);
  // review round3 Minor 1: 件数を出力するだけで何にも失敗しなかったため、
  // ゲートとして機能していなかった。期待値(1件)からずれたら非0で終える。
  const deleteOk = deletedRows.length === 1;
  console.log(`[4] 結果: ${deleteOk ? "1件消せた(正しい)" : "1件ではない(要調査)"}`);
  if (!deleteOk) process.exitCode = 1;
  console.log(`[5] ::"EditLockResource" キャスト: 例外なし(ここまで到達していれば全クエリが通過済み)`);

  // [6] 期限切れの横取りで pre-SELECT と upsert(2文)の間に競合が起きないかを再現する。
  //     review round2 Important 1: 種は「期限のまだ手前(生きている側)」に置く
  //     (+0〜+7ms を周回)。境界の**どちら側を狙って試したか**を先に明示する
  //     (前回の版は無自覚に期限の向こう側を試していたため、常に「非再現」しか
  //     出せなかった)。
  const ATTEMPTS = 200;
  const OFFSET_SWEEP_MS = 8; // i % 8 で +0〜+7ms を周回
  console.log(
    `[6] 種の位置: 期限のちょうど 0〜${OFFSET_SWEEP_MS - 1}ms 手前(まだ生きている側)から開始し、` +
      `DB往復の間に期限をまたぐかどうかで再現を狙う(${ATTEMPTS}回試行)`,
  );
  let reproducedCount = 0;
  let inconclusiveCount = 0;
  for (let i = 0; i < ATTEMPTS; i++) {
    await seedNearExpiryLock(u1.id, i % OFFSET_SWEEP_MS);
    const [r1, r2] = await Promise.all([
      takeoverAttempt(u1.id, `takeover-x-${i}`),
      takeoverAttempt(u2.id, `takeover-y-${i}`),
    ]);
    const winners = [r1, r2].filter((r) => r.won);
    if (winners.length === 1) {
      if (winners[0].takeover === null) reproducedCount++;
    } else {
      // review round3 Minor 2: これは異常ではない。offsetMs が大きい(概ね3ms以上)
      // 回は、両方の pre-SELECT が「まだ生きている」を見た後、どちらの upsert も
      // 期限切れの WHERE を通らずに終わる(0本勝ち)ことが普通に起こる —
      // 種を「まだ生きている側」に置く設計そのものの帰結であり、スイープの
      // 一部が判定不能になるのは意図どおり。健全な実行では reproducedCount +
      // inconclusiveCount + (非nullで勝った回数) = ATTEMPTS になり、
      // inconclusiveCount が数十〜百回程度でも壊れている兆候ではない。
      inconclusiveCount++;
    }
  }
  if (reproducedCount > 0) {
    console.log(
      `[6] 結果: ${ATTEMPTS}回中 ${reproducedCount}回で再現した(勝った方の takeover が null = 監査に横取りとして残らないケースがある。判定不能(0本/2本勝ち。種がまだ生きている側にある以上、正常な範囲) ${inconclusiveCount}回)`,
    );
  } else {
    console.log(
      `[6] 結果: ${ATTEMPTS}回の試行では再現しなかった(判定不能(0本/2本勝ち。offsetMsが大きい回に偏って起きるのが正常) ${inconclusiveCount}回)。再現しないと確定したわけではない点に注意`,
    );
  }

  await prisma.$executeRaw`DELETE FROM "edit_locks" WHERE "resource_id" = ${resourceId}::uuid`;

  // [7] review Important 1: この task が新規に書いた唯一の SQL
  //     (rollback/route.ts の ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE)は、
  //     CI(DBなし)でも order test($queryRaw はモック)でも実行されたことが無い。
  //     配列バインド + text[]→uuid[] キャストが本番DBで本当に通るかをここで確かめる。
  const twoProps = await prisma.property.findMany({ take: 2, select: { id: true } });
  if (twoProps.length < 2) {
    console.log(
      "[7] スキップ: properties が2件未満のため確認できません(先に物件を2件以上用意してください)",
    );
  } else {
    const ids = twoProps.map((p) => p.id);
    const lockedRows = await prisma.$transaction(async (tx) => {
      return tx.$queryRaw`SELECT id FROM properties WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
    });
    console.log(
      `[7] rollback route と同じ ANY(::uuid[]) ORDER BY id FOR UPDATE: ${lockedRows.length}件ロックできた (${ids.length} なら正しい)`,
    );
    if (lockedRows.length !== ids.length) process.exitCode = 1;
  }

  // ── review Important 6(H6追加分)─────────────────────────────────────
  // ここまでの[1]〜[7]は acquire の2文・rollback のバッチロックしか踏んでいない。
  // assertNotEditLockedByOther・heartbeatEditLock・forceReleaseEditLock・
  // isResourceEditLocked は一度も実DBで実行されていなかった。このうち
  // assertNotEditLockedByOther は物件・所有者の**全保存**+corporate-apply で
  // 必ず走るため、bind/型解決の食い違いが1つあれば本番の保存が全部500になる
  // (make_interval の integer/double precision 食い違いと同じ「実行するまで
  // わからない」種類の失敗)。heartbeatEditLock の
  // `CASE WHEN ${active} THEN clock_timestamp() ELSE "activity_at" END` は
  // boolean パラメータの型推論と timestamptz/timestamp の CASE 型解決を同時に
  // 含み、CI では絶対に踏めない。
  await prisma.$executeRaw`DELETE FROM "edit_locks" WHERE "resource_id" = ${resourceId}::uuid`;

  // service.ts の assertNotEditLockedByOther と同じ形(H7で墓標にも期限を足した後の形)。
  // ⚠実物の SQL も保持者(user_id/screen_token_hash)では絞り込まない(行を生のまま
  //   読み、sameHolder の判定は呼び出し側のJSで行う設計。service.ts 参照)。
  const assertNotLockedByOtherQuery = () => prisma.$queryRaw`
    SELECT "id", "user_id", "screen_token_hash",
           ("force_released_at" IS NOT NULL
            AND "force_released_at" >= clock_timestamp() - make_interval(secs => ${GRACE_SEC}::double precision)) AS force_released,
           ("force_released_at" IS NULL
            AND "heartbeat_at" >= clock_timestamp() - make_interval(secs => ${GRACE_SEC}::double precision)
            AND "activity_at" >= clock_timestamp() - make_interval(secs => ${IDLE_SEC}::double precision)) AS active
    FROM "edit_locks"
    WHERE "resource_type" = 'property'::"EditLockResource" AND "resource_id" = ${resourceId}::uuid
  `;

  // service.ts の heartbeatEditLock と同じ形(H1で RETURNING "activity_at" を足した後の形)。
  const heartbeatQuery = (userId, hash, active) => prisma.$queryRaw`
    UPDATE "edit_locks"
    SET "heartbeat_at" = clock_timestamp(),
        "activity_at" = CASE WHEN ${active} THEN clock_timestamp() ELSE "activity_at" END
    WHERE "resource_type" = 'property'::"EditLockResource"
      AND "resource_id" = ${resourceId}::uuid
      AND "user_id" = ${userId}::uuid
      AND "screen_token_hash" = ${hash}
      AND "force_released_at" IS NULL
      AND "heartbeat_at" >= clock_timestamp() - make_interval(secs => ${GRACE_SEC}::double precision)
      AND "activity_at" >= clock_timestamp() - make_interval(secs => ${IDLE_SEC}::double precision)
    RETURNING "id", "activity_at"
  `;

  // service.ts の forceReleaseEditLock と同じ形。
  const forceReleaseQuery = (lockId, adminId) => prisma.$queryRaw`
    UPDATE "edit_locks"
    SET "force_released_at" = clock_timestamp(), "force_released_by" = ${adminId}::uuid
    WHERE "id" = ${lockId}::uuid
      AND "resource_type" = 'property'::"EditLockResource"
      AND "resource_id" = ${resourceId}::uuid
      AND "force_released_at" IS NULL
    RETURNING "user_id"
  `;

  // service.ts の isResourceEditLocked と同じ形。
  const isResourceLockedQuery = () => prisma.$queryRaw`
    SELECT EXISTS (
      SELECT 1 FROM "edit_locks"
      WHERE "resource_type" = 'property'::"EditLockResource"
        AND "resource_id" = ${resourceId}::uuid
        AND "force_released_at" IS NULL
        AND "heartbeat_at" >= clock_timestamp() - make_interval(secs => ${GRACE_SEC}::double precision)
        AND "activity_at" >= clock_timestamp() - make_interval(secs => ${IDLE_SEC}::double precision)
    ) AS locked
  `;

  // [8] assertNotEditLockedByOther 相当: 生きた鍵に対して active/force_released が
  //     型エラー無く boolean で返ることを確認する(sameHolder の判定は呼び出し側JSが行う
  //     設計なので、このSQL自体は保持者では絞り込まない。service.ts と同じ)。
  const got8 = await acquire(u1.id, "screen-8");
  if (got8.length !== 1) {
    console.error("[8] 前提の取得に失敗しました(想定外)");
    process.exitCode = 1;
  } else {
    const rows8 = await assertNotLockedByOtherQuery();
    const ok8 = rows8.length === 1 && rows8[0].active === true && rows8[0].force_released === false;
    console.log(
      `[8] assertNotEditLockedByOther 相当: active=${rows8[0]?.active} force_released=${rows8[0]?.force_released}` +
        `(型エラー無く boolean が返れば正しい。true/false が正しい)`,
    );
    if (!ok8) process.exitCode = 1;
  }

  // [9] heartbeatEditLock 相当: active=true/false の両方の CASE 分岐と、他人の合図が
  //     0件で弾かれることを確認する(boolean パラメータ推論 + timestamptz/timestamp の
  //     CASE 型解決が実DBで通るかは、ここでしか確かめられない)。
  const hbTrue = await heartbeatQuery(u1.id, "screen-8", true);
  const hbFalse = await heartbeatQuery(u1.id, "screen-8", false);
  const hbWrongHolder = await heartbeatQuery(u2.id, "screen-wrong-holder", true);
  console.log(
    `[9] heartbeatEditLock 相当: active=true ${hbTrue.length}件 / active=false ${hbFalse.length}件 / ` +
      `他人 ${hbWrongHolder.length}件(1件・1件・0件が正しい)`,
  );
  if (hbTrue.length !== 1 || hbFalse.length !== 1 || hbWrongHolder.length !== 0) process.exitCode = 1;

  // [10] forceReleaseEditLock 相当: 世代+資源が一致した行にだけ墓標を立て、二重解除は0件。
  const lockRowNow = (await assertNotLockedByOtherQuery())[0];
  const frFirst = await forceReleaseQuery(lockRowNow.id, u2.id);
  const frSecond = await forceReleaseQuery(lockRowNow.id, u2.id);
  console.log(
    `[10] forceReleaseEditLock 相当: 1回目 ${frFirst.length}件 / 2回目(二重解除) ${frSecond.length}件(1件・0件が正しい)`,
  );
  if (frFirst.length !== 1 || frSecond.length !== 0) process.exitCode = 1;

  // [11] isResourceEditLocked 相当: 墓標(force_released_at)は「編集中」に数えない/
  //      生きた鍵は数える、の両方を確認する。
  const lockedAfterForceRelease = await isResourceLockedQuery();
  console.log(
    `[11] isResourceEditLocked 相当(墓標後): locked=${lockedAfterForceRelease[0]?.locked}(falseが正しい)`,
  );
  if (lockedAfterForceRelease[0]?.locked !== false) process.exitCode = 1;

  await prisma.$executeRaw`DELETE FROM "edit_locks" WHERE "resource_id" = ${resourceId}::uuid`;
  const freshAcquire = await acquire(u1.id, "screen-11-fresh");
  const lockedAfterAcquire = await isResourceLockedQuery();
  console.log(
    `[11] isResourceEditLocked 相当(生きた鍵): locked=${lockedAfterAcquire[0]?.locked}(trueが正しい)`,
  );
  if (freshAcquire.length !== 1 || lockedAfterAcquire[0]?.locked !== true) process.exitCode = 1;

  await prisma.$executeRaw`DELETE FROM "edit_locks" WHERE "resource_id" = ${resourceId}::uuid`;

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
  await prisma.$disconnect();
});
