import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(process.cwd(), "prisma/migrations/20260918100000_add_edit_locks/migration.sql"),
  "utf8",
).replace(/\r\n/g, "\n");

describe("edit_locks の migration", () => {
  it("ID は UUID 型(users.id と同じ)", () => {
    expect(sql).toMatch(/"id" UUID NOT NULL/);
    expect(sql).toMatch(/"resource_id" UUID NOT NULL/);
    expect(sql).toMatch(/"user_id" UUID NOT NULL/);
    expect(sql).toMatch(/"force_released_by" UUID/);
  });
  it("1資源1行の一意制約がある", () => {
    expect(sql).toMatch(/UNIQUE INDEX .*edit_locks.*resource_type.*resource_id/s);
  });
  it("利用者を消したら鍵も消える", () => {
    expect(sql).toMatch(/FOREIGN KEY \("user_id"\) REFERENCES "users"\("id"\) ON DELETE CASCADE/);
  });
  it("既存の表を変更しない(追加のみ)", () => {
    expect(sql).not.toMatch(/ALTER TABLE "(properties|owners|users)"/);
    expect(sql).not.toMatch(/DROP /);
  });
});
