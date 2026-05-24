/**
 * Phase 2: rollback route source-assertion テスト
 *
 * route 全体の prisma を mock する integration は既存 Phase 1 でも採用していない。
 * Phase 2 の方針確認は route ソースの構造を assert することで担保する。
 *
 * - AuditLog detail に old/new/current 値を入れない
 * - AuditLog detail は propertyId・fieldNames まで
 * - property_csv 以外は restore も実行しない（Phase 1 のガードを維持）
 * - 二重実行防止は維持（tx 内で status 再確認）
 * - recordChanges を api source で呼ぶ（rollback 実行者の API 操作扱い）
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const routeSrc = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/api/import/jobs/[jobId]/rollback/route.ts",
  ),
  "utf8",
);

describe("rollback route Phase 2 — source-assertion", () => {
  it("AuditLog detail に old/new/current の値そのものを入れない", () => {
    // detail: {...} のブロックを取り出して厳格に検査
    const detailMatch = routeSrc.match(
      /writeAuditLog\(\{[\s\S]*?detail:\s*\{([\s\S]*?)\n\s*\},/,
    );
    expect(detailMatch).not.toBeNull();
    const detailBody = detailMatch![1];
    expect(detailBody).not.toMatch(/\boldValue\b/);
    expect(detailBody).not.toMatch(/\bnewValue\b/);
    expect(detailBody).not.toMatch(/\bcurrentValue\b/);
    expect(detailBody).not.toMatch(/\boldValues\b/);
    expect(detailBody).not.toMatch(/\bnewValues\b/);
    expect(detailBody).not.toMatch(/restoreValue/);
  });

  it("AuditLog detail に restoredFields (propertyId, fieldNames) を含める", () => {
    const detailMatch = routeSrc.match(
      /writeAuditLog\(\{[\s\S]*?detail:\s*\{([\s\S]*?)\n\s*\},/,
    );
    const detailBody = detailMatch![1];
    expect(detailBody).toMatch(/restoredFields/);
    expect(detailBody).toMatch(/fieldNames/);
    expect(detailBody).toMatch(/propertyId/);
    expect(detailBody).toMatch(/restoredPropertyCount/);
    expect(detailBody).toMatch(/restoredFieldCount/);
  });

  it("property_csv 以外は Phase 2 restore も走らない（既存 jobType ガードを維持）", () => {
    // 「jobType !== "property_csv"」の early-return ガードが存在し、
    // ガード後に restore 処理が始まる構造を確認する。
    expect(routeSrc).toMatch(/job\.jobType\s*!==\s*"property_csv"/);
    const guardIdx = routeSrc.search(/job\.jobType\s*!==\s*"property_csv"/);
    const restoreIdx = routeSrc.search(/restorePlans/);
    expect(guardIdx).toBeGreaterThan(0);
    expect(restoreIdx).toBeGreaterThan(guardIdx);
  });

  it("二重実行防止: tx 内で fresh.status !== 'completed' を確認している", () => {
    expect(routeSrc).toMatch(
      /tx\.importJob\.findUnique[\s\S]*?fresh[\s\S]*?status\s*!==\s*"completed"/,
    );
  });

  it("Phase 1 の delete 経路が維持されている（tx.property.delete）", () => {
    expect(routeSrc).toMatch(/tx\.property\.delete\(\{\s*where:\s*\{\s*id:/);
  });

  it("復元自体の ChangeLog は source=api で記録（rollback API 操作扱い）", () => {
    // recordChanges 呼び出し全体を取り出して source の値が "api" になっていることを検証
    const recordMatch = routeSrc.match(/recordChanges\(\{[\s\S]*?\}\);/);
    expect(recordMatch).not.toBeNull();
    expect(recordMatch![0]).toMatch(/source:\s*"api"/);
  });

  it("classifyUpdateFieldsForRestore (Phase 2 純関数) を利用している", () => {
    expect(routeSrc).toMatch(/classifyUpdateFieldsForRestore/);
  });

  it("dryRun レスポンスに restoreDetails と restorableFieldCount を含める", () => {
    // dryRun 時の response 構築 (executed: false) を取り出して検査
    const dryRunResponseMatch = routeSrc.match(
      /if\s*\(dryRun\)\s*\{[\s\S]*?return apiResponse\(\{([\s\S]*?)\n\s*\}\);/,
    );
    expect(dryRunResponseMatch).not.toBeNull();
    const body = dryRunResponseMatch![1];
    expect(body).toMatch(/restoreDetails/);
    expect(body).toMatch(/restorableFieldCount/);
    expect(body).toMatch(/restorable:/);
  });
});
