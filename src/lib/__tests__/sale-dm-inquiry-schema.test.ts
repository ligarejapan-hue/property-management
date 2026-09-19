import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const schema = readFileSync(path.resolve(process.cwd(), "prisma/schema.prisma"), "utf8").replace(/\r\n/g, "\n");
const sql = readFileSync(path.resolve(process.cwd(), "prisma/migrations/20260916100000_add_dm_inquiries/migration.sql"), "utf8").replace(/\r\n/g, "\n");
const block = (name: string) => {
  const start = schema.indexOf(`model ${name} {`);
  expect(start, `model ${name}`).toBeGreaterThan(-1);
  return schema.slice(start, schema.indexOf("\n}", start));
};

describe("査定申込のスキーマ", () => {
  it("DmInquiry の列(設計 §2.5)", () => {
    const m = block("DmInquiry");
    for (const re of [
      /draftId\s+String\s+@map\("draft_id"\) @db\.Uuid/,
      /submittedAt\s+DateTime\s+@default\(now\(\)\) @map\("submitted_at"\)/,
      /name\s+String\n/,
      /phone\s+String\n/,
      /email\s+String\?/,
      /contactPref\s+String\?\s+@map\("contact_pref"\)/,
      /contactTime\s+String\?\s+@map\("contact_time"\)/,
      /message\s+String\?/,
      /handleStatus\s+String\s+@default\("open"\) @map\("handle_status"\)/,
      /handledById\s+String\?\s+@map\("handled_by_id"\) @db\.Uuid/,
      /handledAt\s+DateTime\?\s+@map\("handled_at"\)/,
      /handleNote\s+String\?\s+@map\("handle_note"\)/,
      /notifyStatus\s+String\s+@default\("pending"\) @map\("notify_status"\)/,
      /notifyAttempts\s+Int\s+@default\(0\) @map\("notify_attempts"\)/,
      /notifyLastError\s+String\?\s+@map\("notify_last_error"\)/,
      /onDelete: Restrict/,
      /@@map\("dm_inquiries"\)/,
    ]) expect(m).toMatch(re);
  });
  it("宛先に申込の計数、売却DM設定に同意文", () => {
    expect(block("DmRecipientDraft")).toMatch(/formInquiryCount\s+Int\s+@default\(0\) @map\("form_inquiry_count"\)/);
    expect(block("DmRecipientDraft")).toMatch(/formInquiryFirstAt\s+DateTime\?\s+@map\("form_inquiry_first_at"\)/);
    expect(block("SaleDmConfig")).toMatch(/privacyText\s+String\?\s+@map\("privacy_text"\)/);
  });
  it("migration は additive(削除・更新なし)で、申込の外部キーは RESTRICT", () => {
    expect(sql).toMatch(/CREATE TABLE "dm_inquiries"/);
    expect(sql).toMatch(/ADD COLUMN\s+"form_inquiry_count" INTEGER NOT NULL DEFAULT 0/);
    expect(sql).toMatch(/ADD COLUMN\s+"form_inquiry_first_at" TIMESTAMP\(3\)/);
    expect(sql).toMatch(/ADD COLUMN\s+"privacy_text" TEXT/);
    expect(sql).toMatch(/"dm_inquiries_draft_id_fkey" FOREIGN KEY \("draft_id"\) REFERENCES "dm_recipient_drafts"\("id"\) ON DELETE RESTRICT/);
    expect(sql).not.toMatch(/DROP|UPDATE "|DELETE FROM|ALTER TYPE/i);
  });
});
