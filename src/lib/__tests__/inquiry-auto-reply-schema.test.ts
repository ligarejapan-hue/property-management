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

  // 重複の確認は「直近24時間の申込」を受付日時で絞ってから見る。申込は消さずに残すので、
  // 受付日時の索引が無いと確認のたびに全件を読む(鍵を持ったまま=同じアドレスの申込が待たされる)。
  it("受付日時の索引(schema と migration の名前が一致)", () => {
    expect(block("DmInquiry")).toMatch(/@@index\(\[submittedAt\]\)/);
    const indexSql = read("prisma/migrations/20260930110000_add_dm_inquiries_submitted_at_index/migration.sql");
    expect(indexSql).toMatch(/CREATE INDEX "dm_inquiries_submitted_at_idx" ON "dm_inquiries"\("submitted_at"\);/);
    expect(indexSql).not.toMatch(/^\s*(DROP|UPDATE|DELETE|ALTER)\b/im);
  });

  it("重複の確認は受付日時の下限で絞っている(索引が効く形)", () => {
    const src = read("src/lib/sale-dm-letter/inquiry-auto-reply.ts");
    expect(src).toMatch(/submittedAt: \{ gte: new Date\(submittedAt\.getTime\(\) - AUTO_REPLY_DEDUPE_WINDOW_MS\) \}/);
  });
});
