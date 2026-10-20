-- 案件ステータスの整理(2026-10-20): やめた値の物件を、まとめ先の値へ移す。
-- 対応表は src/lib/property-types.ts の CASE_STATUS_DEPRECATED_MAP と同じ。
-- やめた値は enum に残す(戻すときに安全・古い変更履歴の表示用)。
UPDATE "properties" SET "case_status" = 'contacting_owner'
  WHERE "case_status" IN ('owner_contacted', 'site_checked', 'confirming_owner', 'response_received', 'waiting_registry');
UPDATE "properties" SET "case_status" = 'new_case'
  WHERE "case_status" IN ('dm_target', 'dm_sent');
UPDATE "properties" SET "case_status" = 'closed'
  WHERE "case_status" = 'done';
