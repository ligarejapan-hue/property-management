import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const sql = read("prisma/migrations/20261003100000_add_mlit_agents/migration.sql");
const schema = read("prisma/schema.prisma");

describe("国交省の業者一覧 migration(2026-10-03)", () => {
  it("一覧と進み具合の2表を作る", () => {
    expect(sql).toMatch(/CREATE TABLE "mlit_agents"/);
    expect(sql).toMatch(/CREATE TABLE "mlit_crawl_state"/);
  });
  it("免許の鍵(行政庁2桁+番号6桁)で一意・電話の数字に索引", () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX "mlit_agents_license_key_key" ON "mlit_agents"\("license_key"\);/);
    expect(sql).toMatch(/CREATE INDEX "mlit_agents_phone_digits_idx" ON "mlit_agents"\("phone_digits"\);/);
  });
  it("名簿には「どの一覧の会社から写したか」の列(NULL 可)だけを足す・一覧の行が消えたら NULL に戻す", () => {
    expect(sql).toMatch(/ALTER TABLE "agents" ADD COLUMN "mlit_agent_id" UUID;/);
    expect(sql).toMatch(/"agents_mlit_agent_id_fkey" FOREIGN KEY \("mlit_agent_id"\) REFERENCES "mlit_agents"\("id"\) ON DELETE SET NULL/);
  });
  it("★個人名の列を持たない(代表者・宅建士・政令使用人)", () => {
    const table = sql.match(/CREATE TABLE "mlit_agents" \(([^;]*)\);/)?.[1] ?? "";
    expect(table).not.toBe("");
    expect(table).not.toMatch(/representative|ceo|president|daihyo|person|staff|torihikishi/i);
    const model = schema.match(/model MlitAgent \{([^}]*)\}/)?.[1] ?? "";
    expect(model).not.toBe("");
    expect(model).not.toMatch(/representative|ceo|president|daihyo|person|staff|torihikishi/i);
  });
  it("足すだけ(既存の行・列を変えない・既存の列を NOT NULL にしない)", () => {
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE|DROP)\b/im);
    for (const m of sql.matchAll(/ALTER TABLE "([a-z_]+)" ([A-Z ]+)/g)) {
      expect(m[2], `${m[1]} ${m[2]}`).toMatch(/^ADD (COLUMN|CONSTRAINT)/);
    }
    expect(sql).not.toMatch(/ALTER TABLE "agents" ADD COLUMN "mlit_agent_id" UUID NOT NULL/);
  });
});
