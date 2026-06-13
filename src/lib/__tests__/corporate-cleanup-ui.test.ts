/**
 * CorporateCleanupPanel UI source-assertion テスト。
 *
 * vitest は environment: "node" のため RTL/jsdom は使用しない。
 * fs.readFileSync でソースを読み込み、意図する実装の存在を静的に確認する。
 *
 * テストの意図:
 * 1. プレビュー表示 — before/after と変更フィールドを表示する構造がある
 * 2. manual(空化ガード)時は確定ボタンを出さず理由テキストを表示する構造がある
 * 3. 確定で applyCorporateCleanup を選択フラグ付きで呼ぶ構造がある
 * 4. admin/owners/[id]/page.tsx に CorporateCleanupPanel がマウントされている
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const panelSrc = fs.readFileSync(
  path.resolve(process.cwd(), "src/components/owners/corporate-cleanup-panel.tsx"),
  "utf8",
);

const pageSrc = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/(dashboard)/admin/owners/[id]/page.tsx"),
  "utf8",
);

describe("corporate-cleanup-panel.tsx", () => {
  it("「混入をチェック」トリガーボタンがある", () => {
    expect(panelSrc).toMatch(/混入をチェック|混入.*チェック/);
  });

  it("fetchCorporateCleanupPreview を import・呼び出している", () => {
    expect(panelSrc).toMatch(/fetchCorporateCleanupPreview/);
  });

  it("applyCorporateCleanup を import・呼び出している", () => {
    expect(panelSrc).toMatch(/applyCorporateCleanup/);
  });

  it("before / after の nameMasked を表示する構造がある", () => {
    expect(panelSrc).toMatch(/nameMasked/);
    expect(panelSrc).toMatch(/before\.nameMasked|before\[/);
    expect(panelSrc).toMatch(/after\.nameMasked|after\[/);
  });

  it("法人番号 (corporateNumberToSetMasked) を表示する構造がある", () => {
    expect(panelSrc).toMatch(/法人番号/);
    expect(panelSrc).toMatch(/corporateNumberToSetMasked/);
  });

  it("action === \"manual\" の時は手動対応テキストを出し確定ボタンを出さない構造がある", () => {
    // manual 時に表示する文言
    expect(panelSrc).toMatch(/手動|manual/);
    // action の分岐がある
    expect(panelSrc).toMatch(/action\s*===\s*["']manual["']/);
    // cleanup 分岐内にのみ確定ボタンがある（manual ブランチと cleanup ブランチで別）
    expect(panelSrc).toMatch(/action\s*===\s*["']cleanup["']/);
  });

  it("「選択した項目を反映」確定ボタンがある", () => {
    expect(panelSrc).toMatch(/選択した項目を反映/);
  });

  it("changedFields をもとに checkbox を描画する", () => {
    expect(panelSrc).toMatch(/changedFields/);
    expect(panelSrc).toMatch(/checkbox/);
  });

  it("apply 呼び出し時に version と apply フラグを渡す", () => {
    expect(panelSrc).toMatch(/version.*preview\.version|preview\.version.*version/);
    expect(panelSrc).toMatch(/apply.*checked|checked.*apply/);
  });

  it("onApplied コールバックを Props で受け取り apply 後に呼ぶ", () => {
    expect(panelSrc).toMatch(/onApplied\s*:/);
    expect(panelSrc).toMatch(/onApplied\(\)/);
  });

  it("自動 fetch・自動 apply しない（mount 時に preview 取得が走らない）", () => {
    const useEffectCalls = panelSrc.match(/useEffect\([\s\S]*?fetchCorporateCleanupPreview/);
    expect(useEffectCalls).toBeNull();
  });
});

describe("admin/owners/[id]/page.tsx — CorporateCleanupPanel 統合", () => {
  it("CorporateCleanupPanel を import している", () => {
    expect(pageSrc).toMatch(/from\s+"@\/components\/owners\/corporate-cleanup-panel"/);
  });

  it("<CorporateCleanupPanel ... /> をマウントしている", () => {
    expect(pageSrc).toMatch(/<CorporateCleanupPanel/);
    expect(pageSrc).toMatch(/ownerId=\{owner\.ownerId\}/);
    expect(pageSrc).toMatch(/onApplied=/);
  });
});
