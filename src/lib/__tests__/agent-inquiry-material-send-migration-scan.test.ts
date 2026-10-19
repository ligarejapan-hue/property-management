import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const sql = read("prisma/migrations/20261018120000_add_agent_inquiry_material_sends/migration.sql");

describe("資料送付 migration(spec §5)", () => {
  it("enum と表を作る", () => {
    expect(sql).toMatch(/CREATE TYPE "MaterialSendResult" AS ENUM \('sending', 'sent', 'failed'\);/);
    expect(sql).toMatch(/CREATE TABLE "agent_inquiry_material_sends"/);
  });
  it("反響・送った人へは RESTRICT", () => {
    expect(sql).toMatch(/"agent_inquiry_material_sends_inquiry_id_fkey" FOREIGN KEY \("inquiry_id"\) REFERENCES "agent_inquiries"\("id"\) ON DELETE RESTRICT/);
    expect(sql).toMatch(/"agent_inquiry_material_sends_sent_by_id_fkey" FOREIGN KEY \("sent_by_id"\) REFERENCES "users"\("id"\) ON DELETE RESTRICT/);
  });
  it("押し直しの鍵は送った人ごとに一意・反響×日時の索引", () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX "agent_inquiry_material_sends_sent_by_id_client_token_key" ON "agent_inquiry_material_sends"\("sent_by_id", "client_token"\);/);
    expect(sql).toMatch(/CREATE INDEX "agent_inquiry_material_sends_inquiry_id_created_at_idx" ON "agent_inquiry_material_sends"\("inquiry_id", "created_at"\);/);
  });
  it("反響へ反映した時刻(null=まだ・あとで反映し直す印)", () => {
    expect(sql).toMatch(/"inquiry_applied_at" TIMESTAMP\(3\),/);
  });
  it("送った時点の反響の状態と宛先(反映し直しで手の変更を上書きしない・@codex 8巡目)", () => {
    expect(sql).toMatch(/"status_at_send" "AgentInquiryStatus" NOT NULL,/);
    expect(sql).toMatch(/"contact_email_at_send" TEXT,/);
    expect(sql).toMatch(/"status_edit_seq_at_send" INTEGER NOT NULL,/);
    expect(sql).toMatch(/"contact_email_edit_seq_at_send" INTEGER NOT NULL,/);
  });
  it("反響に、人が状態・宛先を変えた回数(足すだけ・既定 0・@codex 22巡目)", () => {
    expect(sql).toMatch(/ALTER TABLE "agent_inquiries" ADD COLUMN "status_edit_seq" INTEGER NOT NULL DEFAULT 0,\s*ADD COLUMN "contact_email_edit_seq" INTEGER NOT NULL DEFAULT 0;/);
  });
  it("メール設定にひな形の2列(null 可)", () => {
    expect(sql).toMatch(/ALTER TABLE "mail_config" ADD COLUMN "material_send_subject" TEXT,\s*ADD COLUMN "material_send_body" TEXT;/);
  });
  it("足すだけ(消す・型を変える・NOT NULL 化をしない)", () => {
    expect(sql).not.toMatch(/DROP |ALTER COLUMN|SET NOT NULL/);
  });
});
