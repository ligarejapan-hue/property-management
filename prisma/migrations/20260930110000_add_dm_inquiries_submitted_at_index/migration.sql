-- 受付メールの「同じアドレスへ直近に送ったか」の確認は、直近24時間の申込だけを見る。
-- 申込は消さずに残す方針なので、受付日時の索引が無いと確認のたびに全件を読むことになる。
--
-- dm_inquiries は公開LPの申込フォームが書き込む表で、反映中も旧プロセスが申込を受け付けている。
-- 素の CREATE INDEX は構築の間ずっと書き込みを止めるため、CONCURRENTLY を使う
-- (前例: 20260527000000_add_property_gps_bbox_index)。
-- 制約:
--   - CONCURRENTLY は明示的な transaction block (BEGIN/COMMIT) 内で実行できない。
--     このファイルには BEGIN/COMMIT を置かず、文はこの1つだけにする。
--   - 失敗すると INVALID 状態の index が残ることがある。その場合は手動で
--     `DROP INDEX CONCURRENTLY "dm_inquiries_submitted_at_idx";` を実行してから再適用する。

CREATE INDEX CONCURRENTLY "dm_inquiries_submitted_at_idx" ON "dm_inquiries"("submitted_at");
