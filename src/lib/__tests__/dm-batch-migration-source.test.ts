import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// DM送付管理 PR-A migration-A の安全性ピン(設計書 2026-08-08-dm-sending-management-design.md §2.4)。
// additive のみ・enum 新設なし・FK SetNull 化・連関3表の owner_id 先頭索引を SQL/schema の
// ソースで固定する(rollback 安全性と R45/R46/R49 の決定が実装からずれない)。

const read = (p: string) =>
  readFileSync(path.join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

const SQL = read(
  "prisma/migrations/20260808120000_add_dm_sending_records/migration.sql",
);
const SCHEMA = read("prisma/schema.prisma");

describe("migration-A(DM送付記録)の安全性", () => {
  it("additive のみ(DROP TABLE/COLUMN/INDEX・型変更を含まない)", () => {
    expect(SQL).not.toMatch(/DROP (TABLE|COLUMN|INDEX)/i);
    expect(SQL).not.toMatch(/CREATE TYPE|ALTER TYPE/i); // enum 新設禁止(#361 方針)
  });

  it("PropertyDmLog: property_id が nullable + SetNull(削除で履歴を道連れにしない=R49)", () => {
    expect(SQL).toMatch(
      /ALTER TABLE "property_dm_logs" ALTER COLUMN "property_id" DROP NOT NULL/,
    );
    expect(SQL).toMatch(/property_dm_logs_property_id_fkey/);
    expect(SQL).toMatch(/ON DELETE SET NULL/);
    expect(SCHEMA).toMatch(/model PropertyDmLog[\s\S]*?propertyId String\?/);
  });

  it("既存行の updated_at は DEFAULT now() で埋める(NOT NULL 追加で落ちない)", () => {
    expect(SQL).toMatch(
      /ADD COLUMN\s+"updated_at" TIMESTAMP\(3\) NOT NULL DEFAULT CURRENT_TIMESTAMP/,
    );
  });

  it("連関3表すべてに owner_id 先頭の索引(R46)", () => {
    for (const t of [
      "dm_export_batch_item_owners",
      "property_dm_log_owners",
      "dm_recipient_draft_owners",
    ]) {
      expect(SQL).toMatch(
        new RegExp(`CREATE INDEX "${t}_owner_id_idx" ON "${t}"\\("owner_id"\\)`),
      );
    }
  });

  it("PropertyDmLog の新索引: [property_id, sent_at] / [owner_id] / [draft_id](R45)", () => {
    expect(SQL).toMatch(/"property_dm_logs_property_id_sent_at_idx"/);
    expect(SQL).toMatch(/"property_dm_logs_owner_id_idx"/);
    expect(SQL).toMatch(/"property_dm_logs_draft_id_idx"/);
  });

  it("バッチ item の property/owner FK は SetNull(R49・確定を巻き戻さない)", () => {
    expect(SQL).toMatch(
      /"dm_export_batch_items_property_id_fkey"[\s\S]{0,200}?ON DELETE SET NULL/,
    );
    expect(SQL).toMatch(
      /"dm_export_batch_items_owner_id_fkey"[\s\S]{0,200}?ON DELETE SET NULL/,
    );
  });

  it("attempt_key は unique(冪等キー)・sequence 列は作らない(R26=表示時導出)", () => {
    expect(SQL).toMatch(/"dm_export_batches_attempt_key_key"/);
    expect(SQL).not.toMatch(/sequence/i);
  });
});
