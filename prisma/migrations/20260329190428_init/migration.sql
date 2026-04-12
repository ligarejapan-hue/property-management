-- CreateEnum
CREATE TYPE "Role" AS ENUM ('field_staff', 'office_staff', 'admin');

-- CreateEnum
CREATE TYPE "PropertyType" AS ENUM ('land', 'building', 'unknown');

-- CreateEnum
CREATE TYPE "RegistryStatus" AS ENUM ('unconfirmed', 'scheduled', 'obtained');

-- CreateEnum
CREATE TYPE "DmStatus" AS ENUM ('send', 'hold', 'no_send');

-- CreateEnum
CREATE TYPE "CaseStatus" AS ENUM ('new_case', 'site_checked', 'waiting_registry', 'dm_target', 'dm_sent', 'hold', 'done');

-- CreateEnum
CREATE TYPE "RebuildPermission" AS ENUM ('yes', 'no', 'needs_review');

-- CreateEnum
CREATE TYPE "SetbackRequired" AS ENUM ('yes', 'no', 'unknown');

-- CreateEnum
CREATE TYPE "MatchCandidateLevel" AS ENUM ('strong', 'medium', 'weak');

-- CreateEnum
CREATE TYPE "MatchCandidateResult" AS ENUM ('related', 'different', 'pending');

-- CreateEnum
CREATE TYPE "ImportJobStatus" AS ENUM ('pending', 'processing', 'completed', 'failed', 'rolled_back');

-- CreateEnum
CREATE TYPE "ImportJobType" AS ENUM ('property_csv', 'owner_csv', 'dm_history_csv', 'investigation_csv', 'property_pdf');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('success', 'error', 'skipped', 'needs_review');

-- CreateEnum
CREATE TYPE "ChangeSource" AS ENUM ('manual', 'api', 'csv_import', 'pdf_import');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'field_staff',
    "totp_secret" TEXT,
    "totp_enabled" BOOLEAN NOT NULL DEFAULT false,
    "login_failed_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMP(3),
    "must_change_password" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permission_templates" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "permissions" JSONB NOT NULL DEFAULT '{}',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "permission_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_permissions" (
    "id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "template_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_permissions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "user_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "properties" (
    "id" UUID NOT NULL,
    "property_type" "PropertyType" NOT NULL,
    "address" TEXT NOT NULL,
    "original_address" TEXT,
    "lot_number" TEXT,
    "original_lot_number" TEXT,
    "building_number" TEXT,
    "real_estate_number" TEXT,
    "external_link_key" TEXT,
    "registry_status" "RegistryStatus" NOT NULL,
    "dm_status" "DmStatus" NOT NULL,
    "case_status" "CaseStatus" NOT NULL DEFAULT 'new_case',
    "gps_lat" DECIMAL(10,7),
    "gps_lng" DECIMAL(10,7),
    "zoning_district" TEXT,
    "building_coverage_ratio" DECIMAL(5,2),
    "floor_area_ratio" DECIMAL(5,2),
    "height_district" TEXT,
    "fire_prevention_zone" TEXT,
    "scenic_restriction" TEXT,
    "road_type" TEXT,
    "road_width" DECIMAL(5,2),
    "frontage_width" DECIMAL(5,2),
    "frontage_direction" TEXT,
    "setback_required" "SetbackRequired",
    "rosenka_value" INTEGER,
    "rosenka_year" INTEGER,
    "rebuild_permission" "RebuildPermission",
    "investigation_source" TEXT,
    "investigation_fetched_at" TIMESTAMP(3),
    "investigation_confirmed_at" TIMESTAMP(3),
    "manually_edited" BOOLEAN NOT NULL DEFAULT false,
    "architecture_note" TEXT,
    "assigned_to" UUID,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "properties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "owners" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "name_kana" TEXT,
    "phone" TEXT,
    "zip" TEXT,
    "address" TEXT,
    "note" TEXT,
    "external_link_key" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "owners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_owners" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "relationship" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "start_date" DATE,
    "end_date" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "property_owners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_photos" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "file_url" TEXT NOT NULL,
    "thumbnail_url" TEXT,
    "file_name" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "mime_type" TEXT NOT NULL,
    "gps_lat" DECIMAL(10,7),
    "gps_lng" DECIMAL(10,7),
    "taken_at" TIMESTAMP(3),
    "taken_by" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "property_photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_match_candidates" (
    "id" UUID NOT NULL,
    "property_a_id" UUID NOT NULL,
    "property_b_id" UUID NOT NULL,
    "level" "MatchCandidateLevel" NOT NULL,
    "result" "MatchCandidateResult" NOT NULL DEFAULT 'pending',
    "distance_meters" DECIMAL(8,2),
    "match_reason" TEXT,
    "judged_by" UUID,
    "judged_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "property_match_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_investigation_logs" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL,
    "fetched_by" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'success',
    "target_year" INTEGER,
    "data" JSONB NOT NULL DEFAULT '{}',
    "manually_edited" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "property_investigation_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_dm_logs" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "sent_at" DATE NOT NULL,
    "method" TEXT,
    "sent_by" UUID NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "property_dm_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_url" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "mime_type" TEXT NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "property_id" UUID,
    "owner_id" UUID,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "parent_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_logs" (
    "id" UUID NOT NULL,
    "target_table" TEXT NOT NULL,
    "target_id" UUID NOT NULL,
    "field_name" TEXT NOT NULL,
    "old_value" TEXT,
    "new_value" TEXT,
    "source" "ChangeSource" NOT NULL DEFAULT 'manual',
    "changed_by" UUID NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "change_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "action" TEXT NOT NULL,
    "target_table" TEXT,
    "target_id" UUID,
    "detail" JSONB,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "next_actions" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "assigned_to" UUID NOT NULL,
    "scheduled_at" DATE NOT NULL,
    "action_type" TEXT,
    "content" TEXT NOT NULL,
    "is_completed" BOOLEAN NOT NULL DEFAULT false,
    "completed_at" TIMESTAMP(3),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "next_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permission_change_logs" (
    "id" UUID NOT NULL,
    "target_user_id" UUID NOT NULL,
    "changed_by" UUID NOT NULL,
    "change_type" TEXT NOT NULL,
    "old_value" JSONB,
    "new_value" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permission_change_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_jobs" (
    "id" UUID NOT NULL,
    "job_type" "ImportJobType" NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_hash" TEXT,
    "status" "ImportJobStatus" NOT NULL DEFAULT 'pending',
    "total_rows" INTEGER,
    "success_count" INTEGER,
    "error_count" INTEGER,
    "executed_by" UUID NOT NULL,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_job_rows" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "status" "ImportRowStatus" NOT NULL DEFAULT 'needs_review',
    "raw_data" JSONB,
    "error_message" TEXT,
    "created_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_job_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "master_codes" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "master_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "label" TEXT,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_key" ON "password_reset_tokens"("token");

-- CreateIndex
CREATE UNIQUE INDEX "permission_templates_name_key" ON "permission_templates"("name");

-- CreateIndex
CREATE UNIQUE INDEX "template_permissions_template_id_resource_action_key" ON "template_permissions"("template_id", "resource", "action");

-- CreateIndex
CREATE UNIQUE INDEX "user_permissions_user_id_resource_action_key" ON "user_permissions"("user_id", "resource", "action");

-- CreateIndex
CREATE INDEX "properties_case_status_idx" ON "properties"("case_status");

-- CreateIndex
CREATE INDEX "properties_dm_status_idx" ON "properties"("dm_status");

-- CreateIndex
CREATE INDEX "properties_registry_status_idx" ON "properties"("registry_status");

-- CreateIndex
CREATE INDEX "properties_assigned_to_idx" ON "properties"("assigned_to");

-- CreateIndex
CREATE INDEX "properties_is_archived_idx" ON "properties"("is_archived");

-- CreateIndex
CREATE INDEX "properties_updated_at_idx" ON "properties"("updated_at");

-- CreateIndex
CREATE INDEX "properties_real_estate_number_idx" ON "properties"("real_estate_number");

-- CreateIndex
CREATE INDEX "properties_external_link_key_idx" ON "properties"("external_link_key");

-- CreateIndex
CREATE INDEX "owners_name_kana_idx" ON "owners"("name_kana");

-- CreateIndex
CREATE INDEX "owners_external_link_key_idx" ON "owners"("external_link_key");

-- CreateIndex
CREATE UNIQUE INDEX "property_owners_property_id_owner_id_key" ON "property_owners"("property_id", "owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "property_match_candidates_property_a_id_property_b_id_key" ON "property_match_candidates"("property_a_id", "property_b_id");

-- CreateIndex
CREATE INDEX "property_investigation_logs_property_id_fetched_at_idx" ON "property_investigation_logs"("property_id", "fetched_at");

-- CreateIndex
CREATE INDEX "attachments_target_type_target_id_idx" ON "attachments"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "comments_property_id_created_at_idx" ON "comments"("property_id", "created_at");

-- CreateIndex
CREATE INDEX "change_logs_target_table_target_id_idx" ON "change_logs"("target_table", "target_id");

-- CreateIndex
CREATE INDEX "change_logs_changed_at_idx" ON "change_logs"("changed_at");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_idx" ON "audit_logs"("user_id");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "audit_logs_target_table_target_id_idx" ON "audit_logs"("target_table", "target_id");

-- CreateIndex
CREATE INDEX "next_actions_property_id_idx" ON "next_actions"("property_id");

-- CreateIndex
CREATE INDEX "next_actions_assigned_to_is_completed_idx" ON "next_actions"("assigned_to", "is_completed");

-- CreateIndex
CREATE INDEX "next_actions_scheduled_at_idx" ON "next_actions"("scheduled_at");

-- CreateIndex
CREATE INDEX "permission_change_logs_target_user_id_idx" ON "permission_change_logs"("target_user_id");

-- CreateIndex
CREATE INDEX "permission_change_logs_created_at_idx" ON "permission_change_logs"("created_at");

-- CreateIndex
CREATE INDEX "import_jobs_file_hash_idx" ON "import_jobs"("file_hash");

-- CreateIndex
CREATE INDEX "import_jobs_created_at_idx" ON "import_jobs"("created_at");

-- CreateIndex
CREATE INDEX "import_job_rows_job_id_row_number_idx" ON "import_job_rows"("job_id", "row_number");

-- CreateIndex
CREATE INDEX "master_codes_type_is_active_idx" ON "master_codes"("type", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "master_codes_type_value_key" ON "master_codes"("type", "value");

-- CreateIndex
CREATE UNIQUE INDEX "system_settings_key_key" ON "system_settings"("key");

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_permissions" ADD CONSTRAINT "template_permissions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "permission_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "properties" ADD CONSTRAINT "properties_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "properties" ADD CONSTRAINT "properties_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_owners" ADD CONSTRAINT "property_owners_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_owners" ADD CONSTRAINT "property_owners_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "owners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_photos" ADD CONSTRAINT "property_photos_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_photos" ADD CONSTRAINT "property_photos_taken_by_fkey" FOREIGN KEY ("taken_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_match_candidates" ADD CONSTRAINT "property_match_candidates_property_a_id_fkey" FOREIGN KEY ("property_a_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_match_candidates" ADD CONSTRAINT "property_match_candidates_property_b_id_fkey" FOREIGN KEY ("property_b_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_match_candidates" ADD CONSTRAINT "property_match_candidates_judged_by_fkey" FOREIGN KEY ("judged_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_investigation_logs" ADD CONSTRAINT "property_investigation_logs_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_investigation_logs" ADD CONSTRAINT "property_investigation_logs_fetched_by_fkey" FOREIGN KEY ("fetched_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_dm_logs" ADD CONSTRAINT "property_dm_logs_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_dm_logs" ADD CONSTRAINT "property_dm_logs_sent_by_fkey" FOREIGN KEY ("sent_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "owners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "comments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_logs" ADD CONSTRAINT "change_logs_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "next_actions" ADD CONSTRAINT "next_actions_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "next_actions" ADD CONSTRAINT "next_actions_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "next_actions" ADD CONSTRAINT "next_actions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permission_change_logs" ADD CONSTRAINT "permission_change_logs_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permission_change_logs" ADD CONSTRAINT "permission_change_logs_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_executed_by_fkey" FOREIGN KEY ("executed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_job_rows" ADD CONSTRAINT "import_job_rows_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
