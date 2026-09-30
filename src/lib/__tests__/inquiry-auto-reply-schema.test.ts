import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(path.join(root, p), "utf8").replace(/\r\n/g, "\n");
const schema = read("prisma/schema.prisma");
const sql = read("prisma/migrations/20260930100000_add_inquiry_auto_reply/migration.sql");
const block = (name: string) => {
  const start = schema.indexOf(`model ${name} {`);
  expect(start, `model ${name}`).toBeGreaterThan(-1);
  return schema.slice(start, schema.indexOf("\n}", start));
};

describe("申込者への受付メールのスキーマ", () => {
  it("MailConfig にスイッチ(初期OFF)と件名・本文", () => {
    const m = block("MailConfig");
    expect(m).toMatch(/inquiryAutoReplyEnabled\s+Boolean\s+@default\(false\)\s+@map\("inquiry_auto_reply_enabled"\)/);
    expect(m).toMatch(/inquiryAutoReplySubject\s+String\?\s+@map\("inquiry_auto_reply_subject"\)/);
    expect(m).toMatch(/inquiryAutoReplyBody\s+String\?\s+@map\("inquiry_auto_reply_body"\)/);
  });

  it("DmInquiry に送信状態(既定 none=過去の申込には送らない)", () => {
    expect(block("DmInquiry")).toMatch(/autoReplyStatus\s+String\s+@default\("none"\)\s+@map\("auto_reply_status"\)/);
  });

  it("migration は列の追加のみで、既定値が schema と一致する", () => {
    expect(sql).toMatch(/ALTER TABLE "mail_config" ADD COLUMN "inquiry_auto_reply_enabled" BOOLEAN NOT NULL DEFAULT false;/);
    expect(sql).toMatch(/ALTER TABLE "mail_config" ADD COLUMN "inquiry_auto_reply_subject" TEXT;/);
    expect(sql).toMatch(/ALTER TABLE "mail_config" ADD COLUMN "inquiry_auto_reply_body" TEXT;/);
    expect(sql).toMatch(/ALTER TABLE "dm_inquiries" ADD COLUMN "auto_reply_status" TEXT NOT NULL DEFAULT 'none';/);
    expect(sql).not.toMatch(/^\s*(DROP|UPDATE|DELETE|CREATE)\b/im);
    expect(sql).not.toMatch(/ALTER COLUMN/i);
  });
});
