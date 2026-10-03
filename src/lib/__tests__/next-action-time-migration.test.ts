import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isNextActionOverdue } from "@/components/properties/next-action-tab";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const sql = read("prisma/migrations/20261003120000_add_next_action_time/migration.sql");

describe("通知 段階3 の migration(設計書 §6)", () => {
  it("列を足すだけ(既存の列を変えない・消さない)", () => {
    expect(sql).toMatch(/ALTER TABLE "next_actions" ADD COLUMN "scheduled_time" TEXT;/);
    expect(sql).toMatch(/ALTER TABLE "next_actions" ADD COLUMN "reminder_rev_at" TIMESTAMP\(3\);/);
    // 説明のコメント(戻し方に DROP の手順がある)を除いた SQL 本体で確かめる
    const body = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(body).not.toMatch(/\bDROP\b|ALTER COLUMN|NOT NULL/);
  });
  it("時刻は HH:MM だけ(CHECK 制約)", () => {
    expect(sql).toContain(`CHECK ("scheduled_time" IS NULL OR "scheduled_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')`);
  });
  it("順番: トランザクション → 表を押さえる → 列 → 既存行を updated_at で埋める → トリガー → COMMIT", () => {
    const at = (s: string) => sql.indexOf(s);
    const order = [
      "BEGIN;",
      "SET LOCAL lock_timeout = '10s';",
      `LOCK TABLE "next_actions" IN SHARE ROW EXCLUSIVE MODE;`,
      `ADD COLUMN "reminder_rev_at"`,
      `UPDATE "next_actions" SET "reminder_rev_at" = "updated_at"`,
      `CREATE FUNCTION "next_actions_reminder_rev"()`,
      `CREATE TRIGGER "next_actions_reminder_rev"`,
      "COMMIT;",
    ].map(at);
    for (const i of order) expect(i).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it("既存行を埋める UPDATE は版の列だけを書く(updated_at を変えない)", () => {
    const upd = sql.match(/UPDATE "next_actions" SET ([^;]+);/)?.[1] ?? "";
    expect(upd).toBe(`"reminder_rev_at" = "updated_at" WHERE "reminder_rev_at" IS NULL`);
  });
  it("トリガー: INSERT は updated_at と同じ・担当/予定日/時刻/完了の取り消しで前の値+1ミリ秒以上に進め updated_at もそろえる", () => {
    expect(sql).toMatch(/TG_OP = 'INSERT'[\s\S]*NEW\."reminder_rev_at" := NEW\."updated_at";/);
    for (const c of [`NEW."assigned_to" IS DISTINCT FROM OLD."assigned_to"`, `NEW."scheduled_at" IS DISTINCT FROM OLD."scheduled_at"`, `NEW."scheduled_time" IS DISTINCT FROM OLD."scheduled_time"`, `(OLD."is_completed" AND NOT NEW."is_completed")`]) {
      expect(sql).toContain(c);
    }
    expect(sql).toMatch(/GREATEST\(\s*NEW\."updated_at",\s*COALESCE\(OLD\."reminder_rev_at", OLD\."updated_at"\) \+ INTERVAL '1 millisecond'\s*\)/);
    expect(sql).toContain(`NEW."updated_at" := NEW."reminder_rev_at";`);
    expect(sql).toMatch(/BEFORE INSERT OR UPDATE ON "next_actions"/);
  });
  it("schema にも列がある(アプリからは版を書かない)", () => {
    const schema = read("prisma/schema.prisma");
    expect(schema).toMatch(/scheduledTime String\? @map\("scheduled_time"\)/);
    expect(schema).toMatch(/reminderRevAt DateTime\? @map\("reminder_rev_at"\)/);
    for (const p of ["src/app/api/properties/[id]/next-actions/route.ts", "src/app/api/properties/[id]/next-actions/[actionId]/route.ts"]) {
      expect(read(p), p).not.toContain("reminderRevAt");
    }
  });
});

describe("次回対応タブの期限切れ表示", () => {
  const now = new Date("2026-10-03T03:00:00Z"); // 日本時間 12:00
  it("時刻なし: 日本時間の今日の予定は期限切れにしない・昨日は期限切れ", () => {
    expect(isNextActionOverdue("2026-10-03T00:00:00.000Z", null, now)).toBe(false);
    expect(isNextActionOverdue("2026-10-02T00:00:00.000Z", null, now)).toBe(true);
  });
  it("時刻あり: その時刻を過ぎたら期限切れ", () => {
    expect(isNextActionOverdue("2026-10-03T00:00:00.000Z", "11:00", now)).toBe(true);
    expect(isNextActionOverdue("2026-10-03T00:00:00.000Z", "15:00", now)).toBe(false);
  });
});
