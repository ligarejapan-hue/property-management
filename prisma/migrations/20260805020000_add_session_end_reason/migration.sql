-- 巡回の終了理由。null = 人が終了ボタンを押した(従来)。"idle_timeout" = 無操作で自動終了。
-- 圏外で貯めた位置記録を復帰後に受け取れるようにするために使う(自動終了した巡回にだけ許す)。
-- 追加のみ(nullable)なので既存行・既存コードに影響しない。
ALTER TABLE "field_survey_sessions" ADD COLUMN "end_reason" TEXT;
