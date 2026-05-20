/**
 * /admin/owners/correction の duplicate グループ master/source radio UI が
 * disabled を使わず swap ロジック (applyMasterSelection / applySourceSelection)
 * を経由していることの source assertion。
 *
 * 禁止パターン:
 *   - radio に disabled={sourceId === ...} などを付ける（入れ替え不能になる）
 *
 * 要求パターン:
 *   - master radio onChange は handleSelectMaster / applyMasterSelection 経由
 *   - source radio onChange は handleSelectSource / applySourceSelection 経由
 *   - preview ボタンは masterId && sourceId && masterId !== sourceId の時のみ表示
 *   - 実行ボタンは存在しない
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const src = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/(dashboard)/admin/owners/correction/page.tsx",
  ),
  "utf8",
);

describe("correction page: master/source radio UI", () => {
  it("master/source radio に disabled prop を付けていない", () => {
    // type="radio" を含む input 要素を抽出し、disabled が無いこと
    // 旧パターン: disabled={sourceId === m.id} / disabled={masterId === m.id}
    expect(src).not.toMatch(/disabled=\{\s*sourceId\s*===\s*m\.id\s*\}/);
    expect(src).not.toMatch(/disabled=\{\s*masterId\s*===\s*m\.id\s*\}/);
  });

  it("master radio onChange は handleSelectMaster 経由", () => {
    expect(src).toMatch(
      /name=\{`master-\$\{groupIndex\}`\}[\s\S]*?onChange=\{[\s\S]*?handleSelectMaster\(m\.id\)/,
    );
  });

  it("source radio onChange は handleSelectSource 経由", () => {
    expect(src).toMatch(
      /name=\{`source-\$\{groupIndex\}`\}[\s\S]*?onChange=\{[\s\S]*?handleSelectSource\(m\.id\)/,
    );
  });

  it("applyMasterSelection / applySourceSelection を import している", () => {
    expect(src).toMatch(/applyMasterSelection/);
    expect(src).toMatch(/applySourceSelection/);
  });

  it("preview ボタンは masterId && sourceId && masterId !== sourceId の時のみ表示", () => {
    expect(src).toMatch(
      /masterId\s*&&\s*sourceId\s*&&\s*masterId\s*!==\s*sourceId/,
    );
  });

  it("merge execute / 実行ボタンは存在しない", () => {
    // 実行系の文言 / API path が UI に紛れていないこと
    expect(src).not.toMatch(/merge-execute/);
    expect(src).not.toMatch(/統合実行ボタン|統合を実行|merge_execute/);
  });

  it("選択ペア変更時の preview reset (key=`${masterId}:${sourceId}`) は維持", () => {
    expect(src).toMatch(
      /<OwnerMergePreviewButton[\s\S]*?key=\{`\$\{masterId\}:\$\{sourceId\}`\}/,
    );
  });
});
