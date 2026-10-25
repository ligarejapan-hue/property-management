/**
 * 紐づけを外しても台帳を残す migration(2026-10-25)。足す・緩めるだけで、行や列を消さない。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../../../..");
const sql = readFileSync(path.join(root, "prisma/migrations/20261025100000_drive_sync_keep_ledger/migration.sql"), "utf8");
const schema = readFileSync(path.join(root, "prisma/schema.prisma"), "utf8").replace(/\r\n/g, "\n");

describe("台帳を残す migration", () => {
  it("紐づけが消えたら folder_link_id を null にする(行は消さない)", () => {
    expect(sql).toMatch(/ALTER COLUMN "folder_link_id" DROP NOT NULL/);
    expect(sql).toMatch(/FOREIGN KEY \("folder_link_id"\) REFERENCES "property_drive_folders"\("id"\) ON DELETE SET NULL/);
    expect(sql).not.toMatch(/ON DELETE CASCADE/);
  });
  it("書いたときの物件の列を足し、今ある行は紐づけから埋める(外部キーなし)", () => {
    expect(sql).toMatch(/ADD COLUMN "property_id" UUID;/);
    expect(sql).toMatch(/UPDATE "drive_sync_files"[\s\S]*"property_drive_folders"/);
    expect(sql).not.toMatch(/"property_id"\) REFERENCES/);
  });
  it("表・列・行を消さない", () => {
    const code = sql.replace(/--.*$/gm, "");
    expect(code).not.toMatch(/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i);
  });
  it("schema も同じ(null 可・SetNull・property_id)", () => {
    const model = schema.slice(schema.indexOf("model DriveSyncFile {"), schema.indexOf('@@map("drive_sync_files")'));
    expect(model).toMatch(/folderLinkId String\?\s+@map\("folder_link_id"\)/);
    expect(model).toMatch(/propertyId\s+String\?\s+@map\("property_id"\) @db\.Uuid/);
    expect(model).toMatch(/onDelete: SetNull/);
  });
});
