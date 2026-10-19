-- 資料請求への資料送付メールの記録と、メール設定のひな形2列(2026-10-18 発注者承認)。足すだけ。
CREATE TYPE "MaterialSendResult" AS ENUM ('sending', 'sent', 'failed');

CREATE TABLE "agent_inquiry_material_sends" (
    "id" UUID NOT NULL,
    "inquiry_id" UUID NOT NULL,
    "sent_by_id" UUID NOT NULL,
    "to_address" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "attachments" JSONB NOT NULL,
    "total_size" INTEGER NOT NULL,
    "result" "MaterialSendResult" NOT NULL DEFAULT 'sending',
    "error_code" TEXT,
    "client_token" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "inquiry_applied_at" TIMESTAMP(3),
    "status_at_send" "AgentInquiryStatus" NOT NULL,
    "contact_email_at_send" TEXT,
    CONSTRAINT "agent_inquiry_material_sends_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "agent_inquiry_material_sends_sent_by_id_client_token_key" ON "agent_inquiry_material_sends"("sent_by_id", "client_token");
CREATE INDEX "agent_inquiry_material_sends_inquiry_id_created_at_idx" ON "agent_inquiry_material_sends"("inquiry_id", "created_at");
ALTER TABLE "agent_inquiry_material_sends" ADD CONSTRAINT "agent_inquiry_material_sends_inquiry_id_fkey" FOREIGN KEY ("inquiry_id") REFERENCES "agent_inquiries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_inquiry_material_sends" ADD CONSTRAINT "agent_inquiry_material_sends_sent_by_id_fkey" FOREIGN KEY ("sent_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "mail_config" ADD COLUMN "material_send_subject" TEXT,
ADD COLUMN "material_send_body" TEXT;
