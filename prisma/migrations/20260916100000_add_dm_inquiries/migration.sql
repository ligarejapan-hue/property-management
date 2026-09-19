-- 公開LPの査定申込(設計 §2.5)。additive のみ。
ALTER TABLE "dm_recipient_drafts" ADD COLUMN     "form_inquiry_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "form_inquiry_first_at" TIMESTAMP(3);

ALTER TABLE "sale_dm_config" ADD COLUMN     "privacy_text" TEXT;

CREATE TABLE "dm_inquiries" (
    "id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "contact_pref" TEXT,
    "contact_time" TEXT,
    "message" TEXT,
    "handle_status" TEXT NOT NULL DEFAULT 'open',
    "handled_by_id" UUID,
    "handled_at" TIMESTAMP(3),
    "handle_note" TEXT,
    "notify_status" TEXT NOT NULL DEFAULT 'pending',
    "notify_attempts" INTEGER NOT NULL DEFAULT 0,
    "notify_last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dm_inquiries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "dm_inquiries_draft_id_idx" ON "dm_inquiries"("draft_id");

CREATE INDEX "dm_inquiries_handle_status_idx" ON "dm_inquiries"("handle_status");

ALTER TABLE "dm_inquiries" ADD CONSTRAINT "dm_inquiries_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "dm_recipient_drafts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "dm_inquiries" ADD CONSTRAINT "dm_inquiries_handled_by_id_fkey" FOREIGN KEY ("handled_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
