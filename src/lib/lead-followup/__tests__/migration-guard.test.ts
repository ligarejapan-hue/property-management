import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

// 追客の表の守り(migration の中身を読む走査テスト)。
// ⚠物件・申込を消しても追客の行を消さない(SET NULL): 消すと、送ったメールの配信停止リンク(行の id だけ)から
//   アドレスが引けず、停止が記録されないまま「受け付けました」と出てしまう(内部レビュー P2)。
const sql = fs
  .readFileSync(path.join(process.cwd(), "prisma/migrations/20261117000000_lead_followup_mail/migration.sql"), "utf8")
  .replace(/\r\n/g, "\n");
const schema = fs.readFileSync(path.join(process.cwd(), "prisma/schema.prisma"), "utf8").replace(/\r\n/g, "\n");

describe("追客メールの migration", () => {
  it("物件・申込の削除で追客の行は消えない(SET NULL)・送った記録は行と一緒・配信停止は残る", () => {
    expect(sql).toMatch(/"lead_followups_property_id_fkey"[^;]*ON DELETE SET NULL/);
    expect(sql).toMatch(/"lead_followups_inquiry_id_fkey"[^;]*ON DELETE SET NULL/);
    expect(sql).toMatch(/"mail_unsubscribes_followup_id_fkey"[^;]*ON DELETE SET NULL/);
    expect(schema).toMatch(/property\s+Property\?\s+@relation\(fields: \[propertyId\], references: \[id\], onDelete: SetNull\)/);
    expect(schema).toMatch(/inquiry\s+DmInquiry\?\s+@relation\(fields: \[inquiryId\], references: \[id\], onDelete: SetNull\)/);
  });

  it("同じアドレスの進行中は1本まで(部分 UNIQUE)", () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX "lead_followups_one_active_per_email_uniq"\s+ON "lead_followups"\("email_normalized"\)\s+WHERE "status" IN \('active', 'sending'\)/);
  });

  it("足すだけ(表・列を消す・型を変える命令が無い)", () => {
    const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/\bDROP\b/i);
    expect(code).not.toMatch(/ALTER COLUMN/i);
  });
});
