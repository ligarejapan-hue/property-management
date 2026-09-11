import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const schema = readFileSync(path.resolve(process.cwd(), "prisma/schema.prisma"), "utf8").replace(/\r\n/g, "\n");
const sql = readFileSync(path.resolve(process.cwd(), "prisma/migrations/20260911100000_add_dm_phone_tap/migration.sql"), "utf8").replace(/\r\n/g, "\n");

describe("電話タップの列(公開LPの電話ボタン)", () => {
  // DmRecipientDraftOwner は schema.prisma 上で DmRecipientDraft より前(L762)に定義されている。
  // DmRecipientDraft の直後は DmLpVariant(L1225 付近)なので、そちらをブロックの終端に使う。
  const model = schema.slice(schema.indexOf("model DmRecipientDraft {"), schema.indexOf("model DmLpVariant {"));
  it("DmRecipientDraft に phoneTapCount / phoneTapFirstAt がある", () => {
    expect(model).toMatch(/phoneTapCount\s+Int\s+@default\(0\)\s+@map\("phone_tap_count"\)/);
    expect(model).toMatch(/phoneTapFirstAt\s+DateTime\?\s+@map\("phone_tap_first_at"\)/);
  });
  it("migration は additive のみ(ALTER TABLE ADD COLUMN 2本・DROP/UPDATE なし)", () => {
    expect(sql).toMatch(/ALTER TABLE "dm_recipient_drafts" ADD COLUMN\s+"phone_tap_count" INTEGER NOT NULL DEFAULT 0/);
    expect(sql).toMatch(/ADD COLUMN\s+"phone_tap_first_at" TIMESTAMP\(3\)/);
    expect(sql).not.toMatch(/DROP|UPDATE|DELETE/i);
  });
  it("既存の手動の電話反響(phoneInquiryAt)は残っている", () => {
    expect(model).toMatch(/phoneInquiryAt\s+DateTime\?/);
  });
});
