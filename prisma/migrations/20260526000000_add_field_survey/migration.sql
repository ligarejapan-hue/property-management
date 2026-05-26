-- 現地調査マップ Phase 1-A: schema 追加。
-- 巡回 session / track point / pin の 3 テーブル + status enum 2 種。
-- pinType は migration リスク回避のため String + app 側 allowlist で運用。
-- field_survey 権限テンプレートエントリも本 migration でバックフィルする。

-- =========================================================
-- 1. Enum types
-- =========================================================

CREATE TYPE "FieldSurveySessionStatus" AS ENUM ('active', 'ended', 'cancelled');

CREATE TYPE "FieldSurveyPinStatus" AS ENUM ('open', 'closed', 'archived');

-- =========================================================
-- 2. field_survey_sessions
-- =========================================================

CREATE TABLE "field_survey_sessions" (
    "id" UUID NOT NULL,
    "staff_user_id" UUID NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "status" "FieldSurveySessionStatus" NOT NULL DEFAULT 'active',
    "memo" TEXT,
    "point_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "field_survey_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "field_survey_sessions_staff_user_id_started_at_idx"
    ON "field_survey_sessions"("staff_user_id", "started_at");
CREATE INDEX "field_survey_sessions_status_idx"
    ON "field_survey_sessions"("status");

-- 「1 staff につき active session は同時に 1 件まで」を DB レベルで保証する
-- 部分 unique index。double-submit / retry での重複生成 (POST race) を防ぐ。
-- アプリ側は P2002 を ACTIVE_SESSION_EXISTS (409) にマップする。
-- Prisma schema は partial unique を表現できないため、本 SQL でのみ管理する。
CREATE UNIQUE INDEX "field_survey_sessions_one_active_per_staff_uniq"
    ON "field_survey_sessions"("staff_user_id")
    WHERE "status" = 'active';

ALTER TABLE "field_survey_sessions" ADD CONSTRAINT "field_survey_sessions_staff_user_id_fkey"
    FOREIGN KEY ("staff_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =========================================================
-- 3. field_survey_track_points
-- =========================================================

CREATE TABLE "field_survey_track_points" (
    "id" BIGSERIAL NOT NULL,
    "session_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "lat" DECIMAL(10, 7) NOT NULL,
    "lng" DECIMAL(10, 7) NOT NULL,
    "accuracy" DECIMAL(6, 2),
    "recorded_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "field_survey_track_points_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "field_survey_track_points_session_id_sequence_key"
    ON "field_survey_track_points"("session_id", "sequence");
CREATE INDEX "field_survey_track_points_session_id_recorded_at_idx"
    ON "field_survey_track_points"("session_id", "recorded_at");

ALTER TABLE "field_survey_track_points" ADD CONSTRAINT "field_survey_track_points_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "field_survey_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =========================================================
-- 4. field_survey_pins
-- =========================================================

CREATE TABLE "field_survey_pins" (
    "id" UUID NOT NULL,
    "session_id" UUID,
    "staff_user_id" UUID NOT NULL,
    "property_id" UUID,
    "lat" DECIMAL(10, 7) NOT NULL,
    "lng" DECIMAL(10, 7) NOT NULL,
    "accuracy" DECIMAL(6, 2),
    "pin_type" TEXT NOT NULL,
    "status" "FieldSurveyPinStatus" NOT NULL DEFAULT 'open',
    "memo" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "field_survey_pins_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "field_survey_pins_staff_user_id_idx" ON "field_survey_pins"("staff_user_id");
CREATE INDEX "field_survey_pins_session_id_idx" ON "field_survey_pins"("session_id");
CREATE INDEX "field_survey_pins_property_id_idx" ON "field_survey_pins"("property_id");
CREATE INDEX "field_survey_pins_status_idx" ON "field_survey_pins"("status");
CREATE INDEX "field_survey_pins_lat_lng_idx" ON "field_survey_pins"("lat", "lng");

ALTER TABLE "field_survey_pins" ADD CONSTRAINT "field_survey_pins_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "field_survey_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "field_survey_pins" ADD CONSTRAINT "field_survey_pins_staff_user_id_fkey"
    FOREIGN KEY ("staff_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "field_survey_pins" ADD CONSTRAINT "field_survey_pins_property_id_fkey"
    FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- =========================================================
-- 5. field_survey 権限テンプレートエントリのバックフィル
-- (admin / office_staff / field_staff の各テンプレートに既定値を投入)
-- =========================================================

INSERT INTO "template_permissions" ("id", "template_id", "resource", "action", "granted")
SELECT gen_random_uuid(), pt."id", 'field_survey', 'read', true
FROM "permission_templates" pt
WHERE pt."name" IN ('現地担当用', '事務担当用', '管理者用')
ON CONFLICT ("template_id", "resource", "action") DO NOTHING;

INSERT INTO "template_permissions" ("id", "template_id", "resource", "action", "granted")
SELECT gen_random_uuid(), pt."id", 'field_survey', 'write', true
FROM "permission_templates" pt
WHERE pt."name" IN ('現地担当用', '管理者用')
ON CONFLICT ("template_id", "resource", "action") DO NOTHING;

INSERT INTO "template_permissions" ("id", "template_id", "resource", "action", "granted")
SELECT gen_random_uuid(), pt."id", 'field_survey', 'read_all', true
FROM "permission_templates" pt
WHERE pt."name" IN ('事務担当用', '管理者用')
ON CONFLICT ("template_id", "resource", "action") DO NOTHING;

INSERT INTO "template_permissions" ("id", "template_id", "resource", "action", "granted")
SELECT gen_random_uuid(), pt."id", 'field_survey', 'manage', true
FROM "permission_templates" pt
WHERE pt."name" = '管理者用'
ON CONFLICT ("template_id", "resource", "action") DO NOTHING;
