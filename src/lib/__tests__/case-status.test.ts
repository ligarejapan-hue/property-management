import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  CASE_STATUS_VALUES,
  normalizeCaseStatusInput,
} from "../property-types";
import {
  createPropertySchema,
  updatePropertySchema,
  propertyListQuerySchema,
} from "../validators";

// ── 1. バリデータが16新値を accept する ──────────────────────────────────────

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

  it("waiting_registry → confirming_owner", () => {
    expect(normalizeCaseStatusInput("waiting_registry")).toBe("confirming_owner");
  });

  it("done → closed", () => {
    expect(normalizeCaseStatusInput("done")).toBe("closed");
  });

  it("登記待ち → confirming_owner", () => {
    expect(normalizeCaseStatusInput("登記待ち")).toBe("confirming_owner");
  });

  it("謄本待ち → confirming_owner", () => {
    expect(normalizeCaseStatusInput("謄本待ち")).toBe("confirming_owner");
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

// ── 3. normalizeCaseStatusInput が deprecated 値を新規 create に入れないことを確認 ──

describe("buildPropertyCreateData — caseStatus 正規化（純粋関数テスト）", () => {
  // CSV row → createData の caseStatus 部分だけを再現する純粋関数
  function extractCaseStatus(mappedCaseStatus: string | undefined): string {
    return normalizeCaseStatusInput(mappedCaseStatus) ?? "new_case";
  }

  it("waiting_registry を渡すと confirming_owner になる", () => {
    expect(extractCaseStatus("waiting_registry")).toBe("confirming_owner");
  });

  it("done を渡すと closed になる", () => {
    expect(extractCaseStatus("done")).toBe("closed");
  });

  it("登記待ち を渡すと confirming_owner になる", () => {
    expect(extractCaseStatus("登記待ち")).toBe("confirming_owner");
  });

  it("謄本待ち を渡すと confirming_owner になる", () => {
    expect(extractCaseStatus("謄本待ち")).toBe("confirming_owner");
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
});
