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
const qualityAuditPageSrc = readFileSync(
  resolve(
    __dirname,
    "../../../app/(dashboard)/admin/owners/quality-audit/page.tsx",
  ),
  "utf-8",
);

describe("サイドバー: 法人番号紐づけの導線", () => {
  it("「法人番号紐づけ」エントリが復元タブ直行の href で1件ある", () => {
    expect(sidebarSrc).toContain('label: "法人番号紐づけ"');
    const matches = sidebarSrc.match(
      /href:\s*"\/admin\/owners\/correction\?tab=corporate_restore"/g,
    );
    expect(matches).toHaveLength(1);
  });

  it("既存の「所有者補正候補」(クエリなし)も残っている", () => {
    expect(sidebarSrc).toMatch(/href:\s*"\/admin\/owners\/correction"/);
    expect(sidebarSrc).toContain('label: "所有者補正候補"');
  });
});

describe("サイドバー: 品質監査の改名", () => {
  it("「氏名・連絡先チェック」に改名されている", () => {
    expect(sidebarSrc).toContain('label: "氏名・連絡先チェック"');
    expect(sidebarSrc).not.toContain('"品質監査"');
  });

  it("href は /admin/owners/quality-audit のまま(URL不変)", () => {
    expect(sidebarSrc).toMatch(/href:\s*"\/admin\/owners\/quality-audit"/);
  });
});

describe("品質監査ページ: 見出しの改名", () => {
  it("h1・パンくずが「氏名・連絡先チェック」になっている", () => {
    expect(qualityAuditPageSrc).toContain("氏名・連絡先チェック");
    expect(qualityAuditPageSrc).not.toContain("所有者品質監査");
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
