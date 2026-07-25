-- #317: 巡回終了フェンスの世代カウンタ (additive・既存行は 0 から開始)。
-- 位置記録の開始 (フェンス touch) のたびに +1 され、終了/キャンセルは
-- client が終了意図の時点でピン留めした世代との等値でのみ commit できる。
ALTER TABLE "field_survey_sessions" ADD COLUMN "activity_seq" INTEGER NOT NULL DEFAULT 0;
