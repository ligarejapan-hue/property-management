/**
 * サイドバー「法人番号紐づけ」導線と「品質監査」改名の source-assertion テスト。
 *
 * 背景(2026-07-14 ユーザー要望):
 *  - 法人番号の作業場所(所有者補正候補内のタブ)がサイドバーから見えず、
 *    「品質監査」という名前では中身(氏名・カナ・郵便番号・電話の点検)も分からない。
 *  - 対応: データ品質チェックに「法人番号紐づけ」を新設(復元タブへ直行)+
 *    「品質監査」を「氏名・連絡先チェック」へ改名。
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, it, expect } from "vitest";

const sidebarSrc = readFileSync(
  resolve(__dirname, "../sidebar-model.tsx"),
  "utf-8",
);
const qualityAuditPanelSrc = readFileSync(
  resolve(__dirname, "../../owners/checks/quality-audit-panel.tsx"),
  "utf-8",
);
const correctionPageSrc = readFileSync(
  resolve(__dirname, "../../../app/(dashboard)/admin/owners/correction/page.tsx"),
  "utf-8",
);

// 2026-11-24 発注者「わざわざ分けず可能な限りページ数を減らして」: 法人番号紐づけ・氏名・連絡先チェックは
//   メニューの項目ではなく「所有者の直し」のタブになった(dq-two-pages.test.ts)。
describe("法人番号紐づけ: 所有者の直しのタブ", () => {
  it("タブ「法人番号紐づけ」がある", () => {
    expect(correctionPageSrc).toContain('{ key: "corporate_restore", label: "法人番号紐づけ" }');
  });

  it("メニューは「所有者の直し」(クエリなし)1つ", () => {
    expect(sidebarSrc).toMatch(/href:\s*"\/admin\/owners\/correction"/);
    expect(sidebarSrc).toContain('label: "所有者の直し"');
  });
});

describe("品質監査の改名(今は点検タブの名前)", () => {
  it("タブ「氏名・連絡先チェック」がある・旧名は出さない", () => {
    expect(correctionPageSrc).toContain('{ key: "quality_audit", label: "氏名・連絡先チェック" }');
    expect(correctionPageSrc).not.toContain('"品質監査"');
    expect(qualityAuditPanelSrc).not.toContain("所有者品質監査");
  });
});

describe("補正候補ページ: 同一ページ表示中のクエリ遷移への追従", () => {
  const correctionSrc = readFileSync(
    resolve(
      __dirname,
      "../../../app/(dashboard)/admin/owners/correction/page.tsx",
    ),
    "utf-8",
  );

  it("URL変更をレンダー中同期でタブへ反映する(サイドバー直行リンク対応)", () => {
    expect(correctionSrc).toMatch(/urlTab !== syncedUrlTab/);
    expect(correctionSrc).toMatch(/setFilterTypeState\(urlTab\)/);
  });
});
