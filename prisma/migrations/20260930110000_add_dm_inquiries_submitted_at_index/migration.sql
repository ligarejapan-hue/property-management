-- 受付メールの「同じアドレスへ直近に送ったか」の確認は、直近24時間の申込だけを見る。
-- 申込は消さずに残す方針なので、受付日時の索引が無いと確認のたびに全件を読むことになる。
--
-- dm_inquiries は公開LPの申込フォームが書き込む表で、反映中も旧プロセスが申込を受け付けている。
-- 素の CREATE INDEX は構築の間ずっと書き込みを止めるため、CONCURRENTLY を使う
-- (前例: 20260527000000_add_property_gps_bbox_index)。
-- 制約:
--   - CONCURRENTLY は明示的な transaction block (BEGIN/COMMIT) 内で実行できない。
--     このファイルには BEGIN/COMMIT を置かず、文はこの1つだけにする。
--   - 失敗すると INVALID 状態の index が残ることがあり、Prisma はこの migration を「失敗」と
--     記録する(そのままでは次の `prisma migrate deploy` も止まる)。戻し方は次の順:
--       1. `DROP INDEX CONCURRENTLY IF EXISTS "dm_inquiries_submitted_at_idx";`
--       2. `npx prisma migrate resolve --rolled-back 20260930110000_add_dm_inquiries_submitted_at_index`
--       3. `npx prisma migrate deploy` をやり直す
--     (索引が無くてもアプリは動く=確認が遅くなるだけ。急いで戻す必要はない。)

CREATE INDEX CONCURRENTLY "dm_inquiries_submitted_at_idx" ON "dm_inquiries"("submitted_at");
