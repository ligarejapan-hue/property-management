import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  CASE_STATUS_VALUES,
  CASE_STATUS_LABELS,
  CASE_STATUS_DEPRECATED_MAP,
  normalizeCaseStatusInput,
} from "../property-types";
import {
  createPropertySchema,
  updatePropertySchema,
  propertyListQuerySchema,
} from "../validators";

// ── 1. バリデータが12の現役値を accept する(2026-10-20 整理) ──────────────────────────────────────

describe("createPropertySchema — caseStatus", () => {
  it.each(CASE_STATUS_VALUES)("新値 %s を accept する", (v) => {
    const result = createPropertySchema.safeParse({
      propertyType: "land",
      address: "東京都千代田区1-1",
      caseStatus: v,
    });
    expect(result.success).toBe(true);
  });

  it("waiting_registry を reject する", () => {
    const result = createPropertySchema.safeParse({
      propertyType: "land",
      address: "東京都千代田区1-1",
      caseStatus: "waiting_registry",
    });
    expect(result.success).toBe(false);
  });

  it("done を reject する", () => {
    const result = createPropertySchema.safeParse({
      propertyType: "land",
      address: "東京都千代田区1-1",
      caseStatus: "done",
    });
    expect(result.success).toBe(false);
  });
});

describe("updatePropertySchema — caseStatus", () => {
  it.each(CASE_STATUS_VALUES)("新値 %s を accept する", (v) => {
    const result = updatePropertySchema.safeParse({ caseStatus: v, version: 1 });
    expect(result.success).toBe(true);
  });

  it("waiting_registry を reject する", () => {
    const result = updatePropertySchema.safeParse({ caseStatus: "waiting_registry", version: 1 });
    expect(result.success).toBe(false);
  });

  it("done を reject する", () => {
    const result = updatePropertySchema.safeParse({ caseStatus: "done", version: 1 });
    expect(result.success).toBe(false);
  });
});

describe("propertyListQuerySchema — caseStatus フィルタ", () => {
  it.each(CASE_STATUS_VALUES)("新値 %s を accept する", (v) => {
    const result = propertyListQuerySchema.safeParse({ caseStatus: v });
    expect(result.success).toBe(true);
  });

  it("waiting_registry を reject する", () => {
    const result = propertyListQuerySchema.safeParse({ caseStatus: "waiting_registry" });
    expect(result.success).toBe(false);
  });

  it("done を reject する", () => {
    const result = propertyListQuerySchema.safeParse({ caseStatus: "done" });
    expect(result.success).toBe(false);
  });
});

// ── 2. normalizeCaseStatusInput の変換 ─────────────────────────────────────

describe("normalizeCaseStatusInput", () => {
  it.each(CASE_STATUS_VALUES)("アクティブ値 %s はそのまま返す", (v) => {
    expect(normalizeCaseStatusInput(v)).toBe(v);
  });

  it("waiting_registry → contacting_owner", () => {
    expect(normalizeCaseStatusInput("waiting_registry")).toBe("contacting_owner");
  });

  it("done → closed", () => {
    expect(normalizeCaseStatusInput("done")).toBe("closed");
  });

  it("登記待ち → contacting_owner", () => {
    expect(normalizeCaseStatusInput("登記待ち")).toBe("contacting_owner");
  });

  it("謄本待ち → contacting_owner", () => {
    expect(normalizeCaseStatusInput("謄本待ち")).toBe("contacting_owner");
  });

  it("完了 → closed", () => {
    expect(normalizeCaseStatusInput("完了")).toBe("closed");
  });

  it("新規 → new_case", () => {
    expect(normalizeCaseStatusInput("新規")).toBe("new_case");
  });

  it("保留 → hold", () => {
    expect(normalizeCaseStatusInput("保留")).toBe("hold");
  });

  it("不明な値は null", () => {
    expect(normalizeCaseStatusInput("unknown_xyz")).toBeNull();
  });

  it("空文字列は null", () => {
    expect(normalizeCaseStatusInput("")).toBeNull();
  });

  it("null は null", () => {
    expect(normalizeCaseStatusInput(null)).toBeNull();
  });

  it("数値は null", () => {
    expect(normalizeCaseStatusInput(42)).toBeNull();
  });
});

describe("案件ステータスの整理(2026-10-20・12段階)", () => {
  it("現役は12値で、この順に並ぶ", () => {
    expect([...CASE_STATUS_VALUES]).toEqual([
      "new_case", "contacting_owner", "appraisal", "negotiating", "brokerage_obtained", "on_sale",
      "contract_planned", "contracted", "sold", "other_brokerage", "hold", "closed",
    ]);
  });

  it("画面の名前は決めたとおり", () => {
    expect(CASE_STATUS_VALUES.map((v) => CASE_STATUS_LABELS[v])).toEqual([
      "未着手", "所有者とやりとり中", "査定中", "商談中", "媒介取得", "販売中",
      "契約予定", "契約完了", "決済完了", "他社で決まった", "保留", "見送り・終了",
    ]);
  });

  it.each([
    ["owner_contacted", "contacting_owner"],
    ["site_checked", "contacting_owner"],
    ["confirming_owner", "contacting_owner"],
    ["response_received", "contacting_owner"],
    ["dm_target", "new_case"],
    ["dm_sent", "new_case"],
  ])("やめた値 %s → %s", (from, to) => {
    expect(normalizeCaseStatusInput(from)).toBe(to);
  });

  it.each([
    ["新規", "new_case"], ["未着手", "new_case"], ["DM対象", "new_case"], ["DM送付済", "new_case"],
    ["所有者連絡中", "contacting_owner"], ["所有者連絡済", "contacting_owner"], ["現地確認済", "contacting_owner"],
    ["所有者確認中", "contacting_owner"], ["反響あり", "contacting_owner"], ["所有者とやりとり中", "contacting_owner"],
    ["媒介取得済", "brokerage_obtained"], ["媒介取得", "brokerage_obtained"],
    ["契約予定", "contract_planned"], ["契約完了", "contracted"],
    ["売却完了", "sold"], ["決済完了", "sold"],
    ["他社媒介", "other_brokerage"], ["他社で決まった", "other_brokerage"],
    ["終了", "closed"], ["見送り・終了", "closed"], ["保留", "hold"],
  ])("CSVの名前 %s → %s(古い名前も読める)", (from, to) => {
    expect(normalizeCaseStatusInput(from)).toBe(to);
  });

  it.each(["owner_contacted", "site_checked", "confirming_owner", "response_received", "dm_target", "dm_sent"])(
    "やめた値 %s は新しく保存できない",
    (v) => {
      expect(updatePropertySchema.safeParse({ caseStatus: v, version: 1 }).success).toBe(false);
      expect(createPropertySchema.safeParse({ propertyType: "land", address: "東京都千代田区1-1", caseStatus: v }).success).toBe(false);
    },
  );

  it("やめた値も、古い記録を見せるための名前は持つ", () => {
    for (const v of ["owner_contacted", "site_checked", "confirming_owner", "response_received", "dm_target", "dm_sent", "waiting_registry", "done"]) {
      expect(CASE_STATUS_LABELS[v]).toMatch(/（旧）$/);
    }
  });
});

// ── 3. normalizeCaseStatusInput が deprecated 値を新規 create に入れないことを確認 ──

describe("buildPropertyCreateData — caseStatus 正規化（純粋関数テスト）", () => {
  // CSV row → createData の caseStatus 部分だけを再現する純粋関数
  function extractCaseStatus(mappedCaseStatus: string | undefined): string {
    return normalizeCaseStatusInput(mappedCaseStatus) ?? "new_case";
  }

  it("waiting_registry を渡すと contacting_owner になる", () => {
    expect(extractCaseStatus("waiting_registry")).toBe("contacting_owner");
  });

  it("done を渡すと closed になる", () => {
    expect(extractCaseStatus("done")).toBe("closed");
  });

  it("登記待ち を渡すと contacting_owner になる", () => {
    expect(extractCaseStatus("登記待ち")).toBe("contacting_owner");
  });

  it("謄本待ち を渡すと contacting_owner になる", () => {
    expect(extractCaseStatus("謄本待ち")).toBe("contacting_owner");
  });

  it("完了 を渡すと closed になる", () => {
    expect(extractCaseStatus("完了")).toBe("closed");
  });

  it("undefined（値なし）は new_case にフォールバック", () => {
    expect(extractCaseStatus(undefined)).toBe("new_case");
  });

  it("不明値は new_case にフォールバック", () => {
    expect(extractCaseStatus("invalid_status_xyz")).toBe("new_case");
  });
});

// ── 4. migration ファイルが正しく分割されていること ─────────────────────────

import * as fs from "fs";
import * as path from "path";

describe("migration ファイル分割の確認", () => {
  const migDir = path.resolve(__dirname, "../../../prisma/migrations");

  it("20260512000000_add_case_status_values に ADD VALUE のみ含まれる", () => {
    const sql = fs.readFileSync(
      path.join(migDir, "20260512000000_add_case_status_values", "migration.sql"),
      "utf8",
    );
    expect(sql).toMatch(/ALTER TYPE.*ADD VALUE/i);
    expect(sql).not.toMatch(/UPDATE/i);
  });

  it("20260512000001_migrate_deprecated_case_status に UPDATE のみ含まれる", () => {
    const sql = fs.readFileSync(
      path.join(migDir, "20260512000001_migrate_deprecated_case_status", "migration.sql"),
      "utf8",
    );
    expect(sql).toMatch(/UPDATE/i);
    expect(sql).not.toMatch(/ALTER TYPE/i);
  });

  it("ADD VALUE と UPDATE が同一 migration.sql に混在していない", () => {
    const sql1 = fs.readFileSync(
      path.join(migDir, "20260512000000_add_case_status_values", "migration.sql"),
      "utf8",
    );
    const sql2 = fs.readFileSync(
      path.join(migDir, "20260512000001_migrate_deprecated_case_status", "migration.sql"),
      "utf8",
    );
    // migration 1 に UPDATE がない
    expect(sql1).not.toMatch(/^\s*UPDATE/im);
    // migration 2 に ADD VALUE がない
    expect(sql2).not.toMatch(/ADD VALUE/i);
  });

  it("20260512000000 の ADD VALUE に BEFORE / AFTER 順序指定が含まれる", () => {
    const sql = fs.readFileSync(
      path.join(migDir, "20260512000000_add_case_status_values", "migration.sql"),
      "utf8",
    );
    expect(sql).toMatch(/ADD VALUE.*BEFORE/i);
    expect(sql).toMatch(/ADD VALUE.*AFTER/i);
  });

  it("contacting_owner が site_checked の前に来る順序指定になっている", () => {
    const sql = fs.readFileSync(
      path.join(migDir, "20260512000000_add_case_status_values", "migration.sql"),
      "utf8",
    );
    expect(sql).toMatch(/ADD VALUE IF NOT EXISTS 'contacting_owner' BEFORE 'site_checked'/i);
    expect(sql).toMatch(/ADD VALUE IF NOT EXISTS 'owner_contacted' BEFORE 'site_checked'/i);
  });

  it("confirming_owner が site_checked の後に来る順序指定になっている", () => {
    const sql = fs.readFileSync(
      path.join(migDir, "20260512000000_add_case_status_values", "migration.sql"),
      "utf8",
    );
    expect(sql).toMatch(/ADD VALUE IF NOT EXISTS 'confirming_owner' AFTER 'site_checked'/i);
  });

  it("2026-10-20 整理: enum を作り直し、DB の並び(並べ替えの順)が現役12値の順+やめた値は後ろ(@codex #538 P2)", () => {
    const add = fs.readFileSync(path.join(migDir, "20261020120000_case_status_reorg_values", "migration.sql"), "utf8");
    const m = /CREATE TYPE "CaseStatus" AS ENUM \(([^)]*)\)/.exec(add);
    expect(m).not.toBeNull();
    const order = [...m![1].matchAll(/'(\w+)'/g)].map((x) => x[1]);
    expect(order.slice(0, CASE_STATUS_VALUES.length)).toEqual([...CASE_STATUS_VALUES]);
    expect(order.slice(CASE_STATUS_VALUES.length).sort()).toEqual(Object.keys(CASE_STATUS_DEPRECATED_MAP).sort());
    // 列の型を新しい enum へ付け替え、既定値を付け直し、古い型を消す
    expect(add).toMatch(/ALTER COLUMN "case_status" TYPE "CaseStatus" USING "case_status"::text::"CaseStatus"/);
    expect(add).toMatch(/SET DEFAULT 'new_case'/);
    expect(add).toMatch(/DROP TYPE "CaseStatus_old"/);
    expect(add).not.toMatch(/^\s*UPDATE/im);
  });

  it("2026-10-20 整理: schema.prisma の enum の並びも同じ", () => {
    const schema = fs.readFileSync(path.resolve(__dirname, "../../../prisma/schema.prisma"), "utf8");
    const body = /enum CaseStatus \{([^}]*)\}/.exec(schema)![1];
    const vals = body.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, "").trim()).filter(Boolean);
    expect(vals).toEqual([...CASE_STATUS_VALUES, ...Object.keys(CASE_STATUS_DEPRECATED_MAP)]);
  });

  it("2026-10-20 整理: 移し替えは対応表と同じ", () => {
    const mig = fs.readFileSync(path.join(migDir, "20261020120001_case_status_reorg_migrate", "migration.sql"), "utf8");
    expect(mig).not.toMatch(/ADD VALUE/i);
    const fromSql: Record<string, string> = {};
    for (const m of mig.matchAll(/SET "case_status" = '(\w+)'\s+WHERE "case_status" (?:IN \(([^)]*)\)|= '(\w+)')/g)) {
      const froms = m[2] ? [...m[2].matchAll(/'(\w+)'/g)].map((x) => x[1]) : [m[3]];
      for (const f of froms) fromSql[f] = m[1];
    }
    expect(fromSql).toEqual(CASE_STATUS_DEPRECATED_MAP);
  });

  it("closed が done の前に来る順序指定になっている", () => {
    const sql = fs.readFileSync(
      path.join(migDir, "20260512000000_add_case_status_values", "migration.sql"),
      "utf8",
    );
    expect(sql).toMatch(/ADD VALUE IF NOT EXISTS 'closed' BEFORE 'done'/i);
  });
});
