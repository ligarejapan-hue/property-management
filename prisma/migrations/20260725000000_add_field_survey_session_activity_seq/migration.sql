-- #317: 巡回終了フェンスの世代カウンタ (additive・既存行は 0 から開始)。
-- 活動 (touch / track point flush) のたびに +1 され、終了/キャンセルは
-- client がピン留めした世代との等値でのみ commit できる。
ALTER TABLE "field_survey_sessions" ADD COLUMN "activity_seq" INTEGER NOT NULL DEFAULT 0;
