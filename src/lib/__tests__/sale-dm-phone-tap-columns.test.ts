import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const schema = readFileSync(path.resolve(process.cwd(), "prisma/schema.prisma"), "utf8").replace(/\r\n/g, "\n");
const sql = readFileSync(path.resolve(process.cwd(), "prisma/migrations/20260911100000_add_dm_phone_tap/migration.sql"), "utf8").replace(/\r\n/g, "\n");
const pageViewSql = readFileSync(path.resolve(process.cwd(), "prisma/migrations/20260912100000_add_dm_lp_page_view/migration.sql"), "utf8").replace(/\r\n/g, "\n");

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

// 2026-09-12(@codex R10): LP型の「閲覧」を、アプリ内ご案内ページを実際に返せたときだけ数えるための列。
// QR読み取り(lpFirstAccessAt)は外部LPへ転送したときにも立つため、そのままでは LP型ごとの成績に
// 外部LPへの訪問が混ざる。
describe("アプリ内ご案内ページの閲覧の列(公開LP)", () => {
  const model = schema.slice(schema.indexOf("model DmRecipientDraft {"), schema.indexOf("model DmLpVariant {"));
  it("DmRecipientDraft に lpPageFirstAt / lpPageViewCount がある", () => {
    expect(model).toMatch(/lpPageFirstAt\s+DateTime\?\s+@map\("lp_page_first_at"\)/);
    expect(model).toMatch(/lpPageViewCount\s+Int\s+@default\(0\)\s+@map\("lp_page_view_count"\)/);
  });
  it("QR読み取りの列(lpFirstAccessAt / lpAccessCount)は別物として残っている", () => {
    expect(model).toMatch(/lpFirstAccessAt\s+DateTime\?\s+@map\("lp_first_access_at"\)/);
    expect(model).toMatch(/lpAccessCount\s+Int\s+@default\(0\)\s+@map\("lp_access_count"\)/);
  });
  it("migration は additive のみ(ALTER TABLE ADD COLUMN 2本・DROP/UPDATE なし)", () => {
    expect(pageViewSql).toMatch(/ALTER TABLE "dm_recipient_drafts" ADD COLUMN\s+"lp_page_first_at" TIMESTAMP\(3\)/);
    expect(pageViewSql).toMatch(/ALTER TABLE "dm_recipient_drafts" ADD COLUMN\s+"lp_page_view_count" INTEGER NOT NULL DEFAULT 0/);
    expect(pageViewSql).not.toMatch(/DROP|UPDATE|DELETE/i);
  });
});
