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

  // ---- Codex P1#2: JobWindow 形式 (job 開始〜完了 + 小許容) ----
  it("Codex P1#2: JobWindow を構築 (startMs/endMs/executedBy) して helper に渡す", () => {
    expect(routeSrc).toMatch(/JobWindow/);
    expect(routeSrc).toMatch(/startMs\s*:/);
    expect(routeSrc).toMatch(/endMs\s*:/);
    expect(routeSrc).toMatch(/executedBy\s*:/);
    // startMs は job.startedAt または createdAt から取る
    expect(routeSrc).toMatch(/job\.startedAt[\s\S]{0,80}job\.createdAt/);
    expect(routeSrc).toMatch(/ROLLBACK_WINDOW_UPPER_TOLERANCE_MS/);
    // classifyUpdateFieldsForRestore は window 形式で呼ばれる (3rd 引数 allowedFields 追加後も jobWindow を含む)
    expect(routeSrc).toMatch(
      /classifyUpdateFieldsForRestore\([\s\S]{0,200}jobWindow/,
    );
  });

  it("Codex P1#2: completedAt ±5s を ChangeLog の絞り込みに使っていない", () => {
    // 旧実装の hint: 関数引数として completedAtMs を渡す呼び出しは無いはず
    expect(routeSrc).not.toMatch(
      /classifyUpdateFieldsForRestore\([\s\S]{0,200}completedAtMs\s*[,)]/,
    );
  });

  it("Codex P1#2: ChangeLog 取得で changedBy を select に含める (executedBy 絞り込み用)", () => {
    const findManyMatch = routeSrc.match(
      /prisma\.changeLog\.findMany\(\{[\s\S]*?select:\s*\{([\s\S]*?)\n\s*\},/,
    );
    expect(findManyMatch).not.toBeNull();
    expect(findManyMatch![1]).toMatch(/changedBy/);
  });

  // ---- Codex round 2 P1: Property.updatedAt post-import guard for restore ----
  it("Codex P1: restore 側にも prop.updatedAt > completedAt+TOLERANCE のガードがある (post_import_update_detected)", () => {
    expect(routeSrc).toMatch(/post_import_update_detected/);
    // ガードは action:"restore" の blockedDetails として記録される
    const guardBlock = routeSrc.match(
      /prop\.updatedAt\.getTime\(\)\s*>\s*completedAtMs\s*\+\s*TOLERANCE_MS[\s\S]{0,400}action:\s*"restore"/,
    );
    expect(guardBlock).not.toBeNull();
  });

  it("Codex P1: post-import guard の reason に値そのもの (PII) を含めない", () => {
    const reasonMatch = routeSrc.match(
      /post_import_update_detected[\s\S]{0,200}/,
    );
    expect(reasonMatch).not.toBeNull();
    expect(reasonMatch![0]).not.toMatch(/oldValue/);
    expect(reasonMatch![0]).not.toMatch(/newValue/);
    expect(reasonMatch![0]).not.toMatch(/currentValue/);
  });

  // ---- Codex round 2 P2: propertyId 単位への集約 + 重複排除 ----
  it("Codex P2: restoreRows を propertyId 単位に集約してから判定する", () => {
    // Map<propertyId, ClassifiedRow[]> 形式の集約コードが存在する
    expect(routeSrc).toMatch(/rowsByProperty\s*=\s*new Map<string,\s*ClassifiedRow\[\]>/);
    // 集約ループは for...of で propertyId をキーに回す
    expect(routeSrc).toMatch(
      /for\s*\(\s*const\s*\[\s*propertyId\s*,\s*rowsForProp\s*\]\s*of\s+rowsByProperty\s*\)/,
    );
  });

  it("Codex P2: RestorePlan は row ではなく rowNumbers を保持する", () => {
    expect(routeSrc).toMatch(
      /interface\s+RestorePlan\s*\{[\s\S]{0,200}rowNumbers:\s*number\[\]/,
    );
    // 旧形 (row: ClassifiedRow) を残していない
    expect(routeSrc).not.toMatch(
      /interface\s+RestorePlan\s*\{[\s\S]{0,200}row:\s*ClassifiedRow/,
    );
  });

  it("Codex P2: restoreDetails にも rowNumbers が含まれる", () => {
    expect(routeSrc).toMatch(
      /interface\s+RestoreFieldDetail\s*\{[\s\S]{0,300}rowNumbers:\s*number\[\]/,
    );
    // restoreDetails の map で rowNumbers を渡している
    expect(routeSrc).toMatch(
      /restoreDetails[\s\S]{0,300}rowNumbers:\s*p\.rowNumbers/,
    );
  });

  it("Codex P2: AuditLog detail の restoredFields に rowNumbers が入り、PII 値は無い", () => {
    const detailMatch = routeSrc.match(
      /writeAuditLog\(\{[\s\S]*?detail:\s*\{([\s\S]*?)\n\s*\},/,
    );
    expect(detailMatch).not.toBeNull();
    const detailBody = detailMatch![1];
    expect(detailBody).toMatch(/restoredFields/);
    expect(detailBody).toMatch(/rowNumbers/);
    expect(detailBody).not.toMatch(/\boldValue\b/);
    expect(detailBody).not.toMatch(/\bnewValue\b/);
    expect(detailBody).not.toMatch(/restoreValue/);
  });

  it("Codex P2: execute は propertyId 単位で property.update を呼ぶ (row 単位ではない)", () => {
    // tx.property.update の where.id が plan.propertyId (= 集約後の id)
    expect(routeSrc).toMatch(
      /tx\.property\.update\(\{\s*where:\s*\{\s*id:\s*plan\.propertyId\s*\}/,
    );
    // 集約前の row.createdId をそのまま restore update に渡していない
    // (delete 側は row.createdId を使うため、restoreData 文脈に限定して検査)
    const restoreUpdateBlock = routeSrc.match(
      /for\s*\(\s*const\s+plan\s+of\s+restorePlans\s*\)[\s\S]*?await\s+tx\.importJob\.update/,
    );
    expect(restoreUpdateBlock).not.toBeNull();
    expect(restoreUpdateBlock![0]).not.toMatch(
      /tx\.property\.update\(\{\s*where:\s*\{\s*id:\s*row\./,
    );
  });

  // ---- Codex round 3 P2: execute summary を実適用件数ベースにする ----
  it("Codex P2 (round 3): execute response の summary.restorable は restoredPropertyCount を使う", () => {
    // 2 つの apiResponse がある。後者が execute 用 (executed: true)。
    // executed: true を含む方の summary.restorable が事前計画の restorePlans.length を
    // 使っていないことを確認する。
    const responses = routeSrc.match(/apiResponse\(\{[\s\S]*?\}\);/g);
    expect(responses).not.toBeNull();
    const executedResponse = responses!.find((r) => /executed:\s*true/.test(r));
    expect(executedResponse).toBeDefined();
    expect(executedResponse!).toMatch(/restorable:\s*restoredPropertyCount/);
    expect(executedResponse!).toMatch(
      /restorableFieldCount:\s*restoredFieldCount/,
    );
    // 実適用ベースなので、事前計画の restorePlans.length / restorableFieldCount を
    // executed: true ブロックで使っていない
    expect(executedResponse!).not.toMatch(/restorable:\s*restorePlans\.length/);
  });

  it("Codex P2 (round 3): dryRun response の summary は事前計画ベース (restorePlans.length)", () => {
    // ineligible (baseSummary) 系の早期 return も executed: false なので、
    // 事前計画 summary を持つ dryRun response は「restorable: restorePlans.length」を
    // 含む方を特定する。
    const responses = routeSrc.match(/apiResponse\(\{[\s\S]*?\}\);/g);
    expect(responses).not.toBeNull();
    const dryRunPrePlanned = responses!.find(
      (r) =>
        /executed:\s*false/.test(r) &&
        /restorable:\s*restorePlans\.length/.test(r),
    );
    expect(dryRunPrePlanned).toBeDefined();
    // 同じ block 内に事前計画用の restorableFieldCount 変数も使われる
    expect(dryRunPrePlanned!).toMatch(/restorableFieldCount,/);
  });

  it("Codex P2 (round 3): execute 内で currentValues null の plan は blockedDetails に property_missing_at_execute で追加される", () => {
    // if (!currentValues) ブロック直後に blockedDetails.push があり、
    // reason に property_missing_at_execute が含まれる
    expect(routeSrc).toMatch(
      /if\s*\(!currentValues\)\s*\{[\s\S]{0,400}blockedDetails\.push\(\{[\s\S]{0,200}property_missing_at_execute/,
    );
    // 旧実装の `if (!currentValues) continue;` 単独形が残っていない
    expect(routeSrc).not.toMatch(/if\s*\(!currentValues\)\s*continue\s*;/);
  });

  it("Codex P2 (round 3): execute response の restoreDetails は restoreRecordPayloads ベース (実適用)", () => {
    // restoreDetailsApplied は restoreRecordPayloads.map で構築される
    expect(routeSrc).toMatch(/restoreDetailsApplied[\s\S]{0,200}restoreRecordPayloads\.map/);
    // executed: true の response 内で restoreDetails: restoreDetailsApplied
    const responses = routeSrc.match(/apiResponse\(\{[\s\S]*?\}\);/g);
    const executedResponse = responses!.find((r) => /executed:\s*true/.test(r));
    expect(executedResponse!).toMatch(/restoreDetails:\s*restoreDetailsApplied/);
  });

  it("Codex P2 (round 3): property_missing_at_execute の reason に PII 値が含まれない", () => {
    const reasonMatch = routeSrc.match(
      /property_missing_at_execute[\s\S]{0,200}/,
    );
    expect(reasonMatch).not.toBeNull();
    expect(reasonMatch![0]).not.toMatch(/\boldValue\b/);
    expect(reasonMatch![0]).not.toMatch(/\bnewValue\b/);
    expect(reasonMatch![0]).not.toMatch(/currentValue/);
    expect(reasonMatch![0]).not.toMatch(/restoreValue/);
  });

  it("Codex P2 (round 3): AuditLog の restoredPropertyCount / restoredFieldCount は実適用カウント変数を使う", () => {
    const detailMatch = routeSrc.match(
      /writeAuditLog\(\{[\s\S]*?detail:\s*\{([\s\S]*?)\n\s*\},/,
    );
    expect(detailMatch).not.toBeNull();
    const detailBody = detailMatch![1];
    // restoredPropertyCount, restoredFieldCount を変数として参照（事前計画ベースの
    // restorePlans.length / restorableFieldCount を直接使っていない）
    expect(detailBody).toMatch(/restoredPropertyCount/);
    expect(detailBody).toMatch(/restoredFieldCount/);
    expect(detailBody).not.toMatch(/restorePlans\.length/);
    expect(detailBody).not.toMatch(/\brestorableFieldCount\b/);
  });

  // ---- Codex round 4 P1: row-level field evidence (allowedFields) ----
  it("Codex P1 (round 4): import-row-display の extractUpdatedFields を import している", () => {
    expect(routeSrc).toMatch(
      /import\s*\{\s*extractUpdatedFields\s*\}\s*from\s+("|')@\/lib\/import-row-display\1/,
    );
  });

  it("Codex P1 (round 4): job.rows を rowId Map に索引化している", () => {
    expect(routeSrc).toMatch(/rowById\s*=\s*new Map\(job\.rows\.map/);
  });

  it("Codex P1 (round 4): rowsForProp から extractUpdatedFields で allowedFieldsForProp を Set に union している", () => {
    expect(routeSrc).toMatch(
      /allowedFieldsForProp\s*=\s*new Set<string>\(\)/,
    );
    // 各 row の errorMessage から fields を抽出して add している
    expect(routeSrc).toMatch(
      /extractUpdatedFields\(\s*fullRow\.errorMessage\s*\)[\s\S]{0,200}allowedFieldsForProp\.add/,
    );
  });

  it("Codex P1 (round 4): allowedFieldsForProp が空なら property 全体を block (missing_row_field_evidence)", () => {
    expect(routeSrc).toMatch(
      /allowedFieldsForProp\.size\s*===\s*0[\s\S]{0,400}missing_row_field_evidence/,
    );
    // そのブロックは action:"restore" の blockedDetails に行く
    const evidenceBlock = routeSrc.match(
      /allowedFieldsForProp\.size\s*===\s*0[\s\S]{0,400}action:\s*"restore"/,
    );
    expect(evidenceBlock).not.toBeNull();
  });

  it("Codex P1 (round 4): classifyUpdateFieldsForRestore に allowedFieldsForProp を渡す", () => {
    expect(routeSrc).toMatch(
      /classifyUpdateFieldsForRestore\([\s\S]{0,200}jobWindow,\s*allowedFieldsForProp/,
    );
  });

  it("Codex P1 (round 4): missing_row_field_evidence の reason に PII 値が含まれない", () => {
    const reasonMatch = routeSrc.match(
      /missing_row_field_evidence[\s\S]{0,200}/,
    );
    expect(reasonMatch).not.toBeNull();
    expect(reasonMatch![0]).not.toMatch(/\boldValue\b/);
    expect(reasonMatch![0]).not.toMatch(/\bnewValue\b/);
    expect(reasonMatch![0]).not.toMatch(/currentValue/);
    expect(reasonMatch![0]).not.toMatch(/restoreValue/);
  });
});
