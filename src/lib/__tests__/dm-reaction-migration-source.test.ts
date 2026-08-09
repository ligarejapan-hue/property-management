import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// DM送付管理 PR-B migration-B の安全性ピン(設計書 2026-08-08-dm-sending-management-design.md §3)。
// 反響4種は TEXT+アプリ側allowlist(enum 新設禁止)・additive のみ(列追加5+索引1)を
// SQL/schema のソースで固定する(rollback 安全性が実装からずれない)。

const read = (p: string) =>
  readFileSync(path.join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

const SQL = read(
  "prisma/migrations/20260809090000_add_dm_reaction_columns/migration.sql",
);
const SCHEMA = read("prisma/schema.prisma");

describe("migration-B(DM反響列)の安全性", () => {
  it("additive のみ(DROP・型変更・enum 新設を含まない)", () => {
    expect(SQL).not.toMatch(/DROP (TABLE|COLUMN|INDEX)/i);
    expect(SQL).not.toMatch(/CREATE TYPE|ALTER TYPE/i);
    expect(SQL).not.toMatch(/ALTER COLUMN/i); // 既存列は触らない
  });

  it("reaction_status は TEXT NOT NULL DEFAULT 'no_response'(既存行が全件 no_response で埋まる)", () => {
    expect(SQL).toMatch(
      /ALTER TABLE "property_dm_logs" ADD COLUMN\s+"reaction_status" TEXT NOT NULL DEFAULT 'no_response'/,
    );
  });

  it("nullable 列4本(reacted_at/reaction_note/reaction_source/manual_reaction_shadow=JSONB)", () => {
    expect(SQL).toMatch(/ADD COLUMN\s+"reacted_at" TIMESTAMP\(3\)/);
    expect(SQL).toMatch(/ADD COLUMN\s+"reaction_note" TEXT/);
    expect(SQL).toMatch(/ADD COLUMN\s+"reaction_source" TEXT/);
    expect(SQL).toMatch(/ADD COLUMN\s+"manual_reaction_shadow" JSONB/);
    // NOT NULL は reaction_status のみ(既存行を壊さない)
    expect(SQL.match(/NOT NULL/g)?.length).toBe(1);
  });

  it("reaction_status の索引(検査(2)・再送候補の絞り込み用)", () => {
    expect(SQL).toMatch(
      /CREATE INDEX "property_dm_logs_reaction_status_idx" ON "property_dm_logs"\("reaction_status"\)/,
    );
  });

  it("デプロイ手順書に照合スクリプト(one-shot)の実行手順がある(#366 R5)", () => {
    // migration は既存行を no_response で初期化する=照合を実行しないと過去の返戻・返信が
    // 反響なし扱いのまま。運用手順書から漏れると誰も実行しない(@codex #366 R5 P1)。
    const DEPLOY = read("docs/deploy.md");
    expect(DEPLOY).toContain("reconcile-sale-dm-reactions.ts");
    expect(DEPLOY).toContain("--apply");
    expect(DEPLOY).toContain("add_dm_reaction_columns");
  });

  it("schema.prisma: PropertyDmLog に反響5列+索引が定義されている", () => {
    const model = SCHEMA.match(/model PropertyDmLog \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(model).toMatch(
      /reactionStatus\s+String\s+@default\("no_response"\)\s+@map\("reaction_status"\)/,
    );
    expect(model).toMatch(/reactedAt\s+DateTime\?\s+@map\("reacted_at"\)/);
    expect(model).toMatch(/reactionNote\s+String\?\s+@map\("reaction_note"\)/);
    expect(model).toMatch(/reactionSource\s+String\?\s+@map\("reaction_source"\)/);
    expect(model).toMatch(
      /manualReactionShadow\s+Json\?\s+@map\("manual_reaction_shadow"\)/,
    );
    expect(model).toMatch(/@@index\(\[reactionStatus\]\)/);
  });
});
