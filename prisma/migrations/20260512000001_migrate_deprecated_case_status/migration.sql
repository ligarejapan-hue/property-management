-- Migrate deprecated CaseStatus values to new equivalents.
-- waiting_registry → confirming_owner (所有者確認中)
-- done → closed (終了)
-- The old enum values remain in the schema for backward compatibility.
UPDATE "properties" SET "case_status" = 'confirming_owner' WHERE "case_status" = 'waiting_registry';
UPDATE "properties" SET "case_status" = 'closed' WHERE "case_status" = 'done';
