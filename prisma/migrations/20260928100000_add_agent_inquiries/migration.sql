-- 業者からの反響の受付(設計 docs/superpowers/specs/2026-09-28-agent-inquiry-desk-design.md §1/§4)。
-- 新しい表4つ(業者の名簿・反響・内見の予定・広告の可否)と enum 6つを足すだけ。既存の表・行は変えない。
-- ロールバック: コードを戻せば表は参照されなくなるだけ(無害)。

-- CreateEnum
CREATE TYPE "AgentInquiryKind" AS ENUM ('viewing', 'ad_permission', 'material_request');

-- CreateEnum
CREATE TYPE "AgentInquiryChannel" AS ENUM ('phone', 'email', 'fax');

-- CreateEnum
CREATE TYPE "AgentInquiryStatus" AS ENUM ('open', 'in_progress', 'done');

-- CreateEnum
CREATE TYPE "ViewingType" AS ENUM ('guided', 'preview');

-- CreateEnum
CREATE TYPE "AdMedium" AS ENUM ('own_site', 'athome', 'suumo', 'homes', 'other_portal', 'flyer');

-- CreateEnum
CREATE TYPE "AdPermissionValue" AS ENUM ('ok', 'ng', 'ask');

-- CreateTable
CREATE TABLE "agents" (
    "id" UUID NOT NULL,
    "company_name" TEXT NOT NULL,
    "company_kana" TEXT,
    "branch_name" TEXT,
    "license_no" TEXT,
    "phone" TEXT NOT NULL,
    "fax" TEXT,
    "email" TEXT,
    "address" TEXT,
    "note" TEXT,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_inquiries" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "contact_name" TEXT,
    "contact_mobile" TEXT,
    "contact_email" TEXT,
    "kind" "AgentInquiryKind" NOT NULL,
    "channel" "AgentInquiryChannel" NOT NULL DEFAULT 'phone',
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "AgentInquiryStatus" NOT NULL DEFAULT 'open',
    "assignee_id" UUID,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_inquiries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_viewings" (
    "id" UUID NOT NULL,
    "inquiry_id" UUID NOT NULL,
    "scheduled_at" TIMESTAMP(3),
    "viewing_type" "ViewingType" NOT NULL,
    "attendant_id" UUID,
    "result_note" TEXT,
    "canceled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_viewings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_ad_permissions" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "medium" "AdMedium" NOT NULL,
    "value" "AdPermissionValue" NOT NULL,
    "updated_by_id" UUID NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "property_ad_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agents_company_name_idx" ON "agents"("company_name");

-- CreateIndex
CREATE INDEX "agent_inquiries_status_received_at_idx" ON "agent_inquiries"("status", "received_at");

-- CreateIndex
CREATE INDEX "agent_inquiries_property_id_received_at_idx" ON "agent_inquiries"("property_id", "received_at");

-- CreateIndex
CREATE INDEX "agent_inquiries_agent_id_received_at_idx" ON "agent_inquiries"("agent_id", "received_at");

-- CreateIndex
CREATE INDEX "agent_viewings_scheduled_at_idx" ON "agent_viewings"("scheduled_at");

-- CreateIndex
CREATE INDEX "agent_viewings_inquiry_id_idx" ON "agent_viewings"("inquiry_id");

-- CreateIndex
CREATE UNIQUE INDEX "property_ad_permissions_property_id_medium_key" ON "property_ad_permissions"("property_id", "medium");

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_inquiries" ADD CONSTRAINT "agent_inquiries_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_inquiries" ADD CONSTRAINT "agent_inquiries_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_inquiries" ADD CONSTRAINT "agent_inquiries_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_inquiries" ADD CONSTRAINT "agent_inquiries_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_viewings" ADD CONSTRAINT "agent_viewings_inquiry_id_fkey" FOREIGN KEY ("inquiry_id") REFERENCES "agent_inquiries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_viewings" ADD CONSTRAINT "agent_viewings_attendant_id_fkey" FOREIGN KEY ("attendant_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_ad_permissions" ADD CONSTRAINT "property_ad_permissions_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_ad_permissions" ADD CONSTRAINT "property_ad_permissions_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 反響の受付の権限(設計 §4)。全員が使う=3テンプレートすべてに付与。DDL は無い(resource/action は素の文字列)。
-- fresh DB ではテンプレート未作成のため 0 行になり、seed が同じ行を作る。
INSERT INTO "template_permissions" ("id", "template_id", "resource", "action", "granted")
SELECT gen_random_uuid(), pt."id", 'agent_inquiry', 'read', true
FROM "permission_templates" pt
WHERE pt."name" IN ('管理者用', '事務担当用', '現地担当用')
ON CONFLICT ("template_id", "resource", "action") DO NOTHING;

INSERT INTO "template_permissions" ("id", "template_id", "resource", "action", "granted")
SELECT gen_random_uuid(), pt."id", 'agent_inquiry', 'write', true
FROM "permission_templates" pt
WHERE pt."name" IN ('管理者用', '事務担当用', '現地担当用')
ON CONFLICT ("template_id", "resource", "action") DO NOTHING;
