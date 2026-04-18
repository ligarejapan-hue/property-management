-- ハザード詳細カラム追加
-- 各フィールドは reinfolib XKT タイル API の取得結果を格納する。
-- features 空配列（指定なし地域）の場合は NULL になる。

ALTER TABLE "property_investigations"
  ADD COLUMN IF NOT EXISTS "flood_risk_level"        TEXT,  -- XKT026 洪水浸水想定区域
  ADD COLUMN IF NOT EXISTS "storm_surge_risk_level"  TEXT,  -- XKT027 高潮浸水想定区域
  ADD COLUMN IF NOT EXISTS "tsunami_risk_level"      TEXT,  -- XKT028 津波浸水想定区域
  ADD COLUMN IF NOT EXISTS "sediment_risk_category"  TEXT,  -- XKT029 土砂災害警戒区域
  ADD COLUMN IF NOT EXISTS "liquefaction_risk_level" TEXT;  -- XKT025 液状化危険度
