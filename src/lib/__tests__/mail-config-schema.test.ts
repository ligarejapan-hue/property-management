import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import path from "path";

const root = process.cwd();
const schema = readFileSync(path.join(root, "prisma/schema.prisma"), "utf8").replace(/\r\n/g, "\n");

describe("メール通知のスキーマ", () => {
  it("MailConfig は singleton で、パスワードは暗号文の列だけを持つ", () => {
    const m = schema.match(/model MailConfig \{([\s\S]*?)\n\}/);
    expect(m).not.toBeNull();
    const body = m![1];
    for (const col of ["smtpHost", "smtpPort", "smtpSecure", "smtpUser", "smtpPassEnc", "fromAddress", "appBaseUrl", "inquiryMailDetail", "updatedAt", "updatedById"]) {
      expect(body).toContain(col);
    }
    expect(body).toMatch(/id\s+String\s+@id @default\("singleton"\)/);
    expect(body).not.toMatch(/smtpPass\s+String/);
    expect(body).toContain('@@map("mail_config")');
  });
  it("User に通知の2列・DmInquiry に notifyClaimedAt/notifySentUserIds", () => {
    expect(schema).toMatch(/inquiryNotifyEnabled\s+Boolean\s+@default\(false\)\s+@map\("inquiry_notify_enabled"\)/);
    expect(schema).toMatch(/inquiryNotifyEmail\s+String\?\s+@map\("inquiry_notify_email"\)/);
    expect(schema).toMatch(/notifyClaimedAt\s+DateTime\?\s+@map\("notify_claimed_at"\)/);
    // P2修正(Finding2 r5): 送信成功済みの宛先user idを追記する列。個人情報を含まない
    // (user idのみ)・default '{}' の追加のみ(既存行はバックフィル不要)。
    expect(schema).toMatch(/notifySentUserIds\s+String\[\]\s+@default\(\[\]\)\s+@map\("notify_sent_user_ids"\)\s+@db\.Uuid/);
  });
  it("migration は追加のみ(DROP/ALTER COLUMN TYPE を含まない)", () => {
    const dir = path.join(root, "prisma/migrations/20260918100000_add_mail_config_and_inquiry_notify");
    expect(readdirSync(dir)).toContain("migration.sql");
    const sql = readFileSync(path.join(dir, "migration.sql"), "utf8");
    expect(sql).toContain('CREATE TABLE "mail_config"');
    expect(sql).not.toMatch(/^\s*DROP\b/im);
    expect(sql).not.toMatch(/ALTER COLUMN[^;]*TYPE/i);
  });
  it("notifySentUserIds の migration も追加のみ(DROP/ALTER COLUMN TYPE を含まない)", () => {
    const dir = path.join(root, "prisma/migrations/20260919100000_add_inquiry_notify_sent_user_ids");
    expect(readdirSync(dir)).toContain("migration.sql");
    const sql = readFileSync(path.join(dir, "migration.sql"), "utf8");
    expect(sql).toMatch(/ALTER TABLE "dm_inquiries" ADD COLUMN "notify_sent_user_ids" UUID\[\] NOT NULL DEFAULT '\{\}'/);
    expect(sql).not.toMatch(/^\s*DROP\b/im);
    expect(sql).not.toMatch(/ALTER COLUMN[^;]*TYPE/i);
  });
  it("nodemailer は dependencies・型は devDependencies", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(pkg.dependencies.nodemailer).toBeDefined();
    expect(pkg.devDependencies["@types/nodemailer"]).toBeDefined();
  });
});
