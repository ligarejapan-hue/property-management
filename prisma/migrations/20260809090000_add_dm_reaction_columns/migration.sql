-- DM送付管理 PR-B: 送付記録への反響列の追加(設計 2026-08-08-dm-sending-management-design.md §3)
-- 反響4種(no_response/replied/refused/undeliverable)は TEXT+アプリ側allowlist(enum新設禁止)。
-- additive のみ(列追加5+索引1)。既存行は全件 no_response で埋まる。
ALTER TABLE "property_dm_logs" ADD COLUMN "reaction_status" TEXT NOT NULL DEFAULT 'no_response';
ALTER TABLE "property_dm_logs" ADD COLUMN "reacted_at" TIMESTAMP(3);
ALTER TABLE "property_dm_logs" ADD COLUMN "reaction_note" TEXT;
ALTER TABLE "property_dm_logs" ADD COLUMN "reaction_source" TEXT;
-- 手動値を同期が上書きするときの全量退避(status/reactedAt/note=R44)
ALTER TABLE "property_dm_logs" ADD COLUMN "manual_reaction_shadow" JSONB;

-- 検査(2)=拒否/宛先不明の宛先検出・PR-C再送候補の絞り込み用
CREATE INDEX "property_dm_logs_reaction_status_idx" ON "property_dm_logs"("reaction_status");
