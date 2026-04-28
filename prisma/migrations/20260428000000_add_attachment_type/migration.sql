-- AlterTable: attachments に type を追加（"general" | "registry"）
-- 既存行は "general" 扱い
ALTER TABLE "attachments" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'general';
