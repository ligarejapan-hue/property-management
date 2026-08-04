-- 自動終了した後に位置記録が届いた巡回の印 (@codex #356 P1)。
-- true の間は踏破マップ (coverage/cells・coverage/tracks) に出さない
-- = まだ歩いている人の現在位置が他スタッフに見えるのを防ぐ。
-- 既存行は NULL (= 未判定) で、SQL 側は `IS NOT TRUE` で扱うため挙動不変。
ALTER TABLE "field_survey_sessions" ADD COLUMN "reconcile_pending" BOOLEAN;
