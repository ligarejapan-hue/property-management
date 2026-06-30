-- A/B 型ごとの LP(印刷QR /t/<token> の遷移先)。未設定の型は SALE_DM_LP_URL(既定)へフォールバック。
-- nullable・既存行は NULL(=既定LPを使う)ので backfill 不要・後方互換。
ALTER TABLE "dm_variants" ADD COLUMN "lp_url" TEXT;
