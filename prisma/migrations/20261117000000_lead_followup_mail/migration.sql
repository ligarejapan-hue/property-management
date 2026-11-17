-- 一括査定・査定申込のお客様への追客メール(ステップメール)の第1段(設計 docs/superpowers/specs/2026-11-16-inquiry-followup-mail-design.md)。
-- 表を4つ作り、mail_config に列を3つ足すだけ(今ある列・表は変えない・消さない)。初期=追客 OFF・文面0件=何も送らない。
-- 戻すとき: 4つの表を DROP し、mail_config の3列を DROP する(ほかは触らない)。

-- AlterTable
ALTER TABLE "mail_config" ADD COLUMN     "followup_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "followup_enabled_at" TIMESTAMP(3),
ADD COLUMN     "followup_version" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "lead_followup_steps" (
    "id" UUID NOT NULL,
    "series" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "delay_days" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_id" UUID,

    CONSTRAINT "lead_followup_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_followups" (
    "id" UUID NOT NULL,
    "target_type" TEXT NOT NULL,
    "property_id" UUID,
    "inquiry_id" UUID,
    "email_normalized" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "stop_reason" TEXT,
    "new_started_at" TIMESTAMP(3),
    "new_next_position" INTEGER NOT NULL DEFAULT 1,
    "hold_started_at" TIMESTAMP(3),
    "hold_next_position" INTEGER NOT NULL DEFAULT 1,
    "last_sent_at" TIMESTAMP(3),
    "claimed_at" TIMESTAMP(3),
    "stopped_at" TIMESTAMP(3),
    "stopped_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_followups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_followup_sends" (
    "id" UUID NOT NULL,
    "followup_id" UUID NOT NULL,
    "series" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "result" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_followup_sends_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_unsubscribes" (
    "id" UUID NOT NULL,
    "email_normalized" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "followup_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_unsubscribes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lead_followup_steps_series_position_key" ON "lead_followup_steps"("series", "position");

-- CreateIndex
CREATE UNIQUE INDEX "lead_followups_property_id_key" ON "lead_followups"("property_id");

-- CreateIndex
CREATE UNIQUE INDEX "lead_followups_inquiry_id_key" ON "lead_followups"("inquiry_id");

-- CreateIndex
CREATE INDEX "lead_followups_status_idx" ON "lead_followups"("status");

-- CreateIndex
CREATE INDEX "lead_followups_email_normalized_idx" ON "lead_followups"("email_normalized");

-- CreateIndex
CREATE UNIQUE INDEX "lead_followup_sends_followup_id_series_position_key" ON "lead_followup_sends"("followup_id", "series", "position");

-- CreateIndex
CREATE UNIQUE INDEX "mail_unsubscribes_email_normalized_key" ON "mail_unsubscribes"("email_normalized");

-- AddForeignKey
ALTER TABLE "lead_followups" ADD CONSTRAINT "lead_followups_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_followups" ADD CONSTRAINT "lead_followups_inquiry_id_fkey" FOREIGN KEY ("inquiry_id") REFERENCES "dm_inquiries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_followups" ADD CONSTRAINT "lead_followups_stopped_by_id_fkey" FOREIGN KEY ("stopped_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_followup_sends" ADD CONSTRAINT "lead_followup_sends_followup_id_fkey" FOREIGN KEY ("followup_id") REFERENCES "lead_followups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_unsubscribes" ADD CONSTRAINT "mail_unsubscribes_followup_id_fkey" FOREIGN KEY ("followup_id") REFERENCES "lead_followups"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- 対象は target_type の側だけ(一括査定の物件 or 査定申込)。物件・申込を消しても行は残る(SET NULL)=
-- 送ったメールの配信停止リンクからアドレスを引けるようにするため(行を消すと停止が記録できなくなる)。
ALTER TABLE "lead_followups" ADD CONSTRAINT "lead_followups_target_check" CHECK (
  ("target_type" = 'property' AND "inquiry_id" IS NULL)
  OR ("target_type" = 'inquiry' AND "property_id" IS NULL)
);
ALTER TABLE "lead_followups" ADD CONSTRAINT "lead_followups_status_check"
  CHECK ("status" IN ('active', 'sending', 'completed', 'stopped'));
ALTER TABLE "lead_followup_steps" ADD CONSTRAINT "lead_followup_steps_series_check"
  CHECK ("series" IN ('new', 'hold'));
ALTER TABLE "lead_followup_steps" ADD CONSTRAINT "lead_followup_steps_delay_check"
  CHECK ("delay_days" BETWEEN 0 AND 365 AND "position" >= 1);
ALTER TABLE "lead_followup_sends" ADD CONSTRAINT "lead_followup_sends_result_check"
  CHECK ("result" IN ('sent', 'skipped', 'failed'));

-- 同じアドレスの進行中の追客は1本まで(送る処理のアドレス単位のロックに加えた最後の守り)。
CREATE UNIQUE INDEX "lead_followups_one_active_per_email_uniq"
  ON "lead_followups"("email_normalized")
  WHERE "status" IN ('active', 'sending');
