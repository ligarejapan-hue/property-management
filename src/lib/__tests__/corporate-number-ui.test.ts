/**
 * 物件詳細ページの Owner 編集 / 表示への法人番号統合 source-assertion。
 *
 * - 法人番号欄が編集フォームにある
 * - 13桁検証エラーメッセージ導線がある
 * - 候補検出バナーが組み込まれている
 * - editable / form / payload に corporateNumber が反映されている
 * - 管理ID 検索欄等の既存UIを壊さない
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const pageSrc = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/(dashboard)/properties/[id]/page.tsx",
  ),
  "utf8",
);

const editUtilsSrc = fs.readFileSync(
  path.resolve(process.cwd(), "src/lib/owner-edit-utils.ts"),
  "utf8",
);

const ownerDetailPanelSrc = fs.readFileSync(
  path.resolve(process.cwd(), "src/components/owners/owner-detail-panel.tsx"),
  "utf8",
);

const seedSrc = fs.readFileSync(
  path.resolve(process.cwd(), "prisma/seed.ts"),
  "utf8",
);

describe("Property detail page — 法人番号欄", () => {
  it("editableFields に corporateNumber がある", () => {
    expect(pageSrc).toMatch(/corporateNumber:\s*hasFullPerm\("owner_corporate_number"\)/);
  });

  it("OwnerEditableFields の corporateNumber を edit/full どちらでも有効化する", () => {
    expect(pageSrc).toMatch(/hasEditPerm\("owner_corporate_number"\)/);
  });

  it("編集フォーム input が法人番号用に追加されている", () => {
    expect(pageSrc).toMatch(/法人番号（任意 \/ 13桁）/);
    expect(pageSrc).toMatch(/inputMode="numeric"/);
  });

  it("法人番号 input に maxLength={13} を付けない（ハイフン・空白・全角数字を含む入力を許容するため）", () => {
    // 正規化前の文字列（1234-5678-9012-3 / 全角数字 / 空白混じり）が13文字を超えても
    // UI 上で truncate されないこと。送信時に normalizeCorporateNumber が13桁へ正規化する。
    const corporateInputSection = pageSrc.match(
      /editableFields\.corporateNumber[\s\S]*?placeholder="例: 1234567890123"[\s\S]*?\/>/,
    );
    expect(corporateInputSection).not.toBeNull();
    expect(corporateInputSection?.[0]).not.toMatch(/maxLength=/);
  });

  it("13桁検証エラーが表示される", () => {
    expect(pageSrc).toMatch(/法人番号は13桁の数字で入力してください/);
  });

  it("normalizeCorporateNumber を import している", () => {
    expect(pageSrc).toMatch(/normalizeCorporateNumber/);
  });

  it("保存ボタンの disabled に corporateNumber 検証が組み込まれている", () => {
    expect(pageSrc).toMatch(
      /editableFields\.corporateNumber[\s\S]{0,200}normalizeCorporateNumber\(form\.corporateNumber\) === null/,
    );
  });

  it("表示ビューに法人番号フィールドがある", () => {
    expect(pageSrc).toMatch(/label="法人番号"/);
  });

  it("候補検出バナー CorporateNumberSuspectBanner が定義されている", () => {
    expect(pageSrc).toMatch(/function CorporateNumberSuspectBanner/);
    expect(pageSrc).toMatch(/detectCorporateNumberInOwnerLike/);
  });

  it("管理ID 検索欄の既存実装が壊れていない", () => {
    // PR #30 で追加された mgmtIdText を破壊しない（properties 一覧側のテストは別だが、
    // ここでは物件詳細ページ側に管理ID UI が混入していないことを確認するだけ）
    expect(pageSrc).toMatch(/管理ID/); // 既存「管理ID」表示は残す
  });
});

describe("owner-edit-utils — corporateNumber", () => {
  it("OwnerEditableFields 型に corporateNumber がある", () => {
    expect(editUtilsSrc).toMatch(/corporateNumber:\s*boolean/);
  });

  it("OwnerFormValues 型に corporateNumber がある", () => {
    expect(editUtilsSrc).toMatch(/corporateNumber:\s*string/);
  });

  it("buildOwnerUpdatePayload が fields.corporateNumber を見る", () => {
    expect(editUtilsSrc).toMatch(
      /if \(fields\.corporateNumber\)[\s\S]{0,150}payload\.corporateNumber/,
    );
  });
});

describe("seed.ts — owner_corporate_number デフォルト権限", () => {
  // owner_name と同等の扱いで全テンプレートに owner_corporate_number が含まれること。
  // fresh seed 環境でも admin / office / field_staff が法人番号を扱えるよう、
  // permissions JSON / templateEntries 配列の両方に追加されている必要がある。

  it("field_staff テンプレート permissions JSON に owner_corporate_number がある", () => {
    // owner_name と同等（full）。permissions: { ... } ブロック全体を抽出して検査。
    const fieldStaffSection = seedSrc.match(
      /name:\s*"現地担当用"[\s\S]*?audit_log:[\s\S]*?\},/,
    );
    expect(fieldStaffSection).not.toBeNull();
    expect(fieldStaffSection?.[0]).toMatch(
      /owner_corporate_number:\s*\{\s*full:\s*true\s*\}/,
    );
  });

  it("office_staff テンプレート permissions JSON に owner_corporate_number がある", () => {
    const officeStaffSection = seedSrc.match(
      /name:\s*"事務担当用"[\s\S]*?audit_log:[\s\S]*?\},/,
    );
    expect(officeStaffSection).not.toBeNull();
    expect(officeStaffSection?.[0]).toMatch(
      /owner_corporate_number:\s*\{\s*full:\s*true\s*\}/,
    );
  });

  it("admin テンプレート permissions JSON に owner_corporate_number がある", () => {
    const adminSection = seedSrc.match(
      /name:\s*"管理者用"[\s\S]*?audit_log:[\s\S]*?\},/,
    );
    expect(adminSection).not.toBeNull();
    expect(adminSection?.[0]).toMatch(
      /owner_corporate_number:\s*\{\s*full:\s*true\s*\}/,
    );
  });

  it("templateEntries 配列に field_staff の owner_corporate_number:full がある", () => {
    expect(seedSrc).toMatch(
      /templateId:\s*fieldStaffTemplate\.id,\s*resource:\s*"owner_corporate_number",\s*action:\s*"full",\s*granted:\s*true/,
    );
  });

  it("templateEntries 配列に office_staff の owner_corporate_number:full がある", () => {
    expect(seedSrc).toMatch(
      /templateId:\s*officeStaffTemplate\.id,\s*resource:\s*"owner_corporate_number",\s*action:\s*"full",\s*granted:\s*true/,
    );
  });

  it("templateEntries 配列に admin の owner_corporate_number:full がある", () => {
    expect(seedSrc).toMatch(
      /templateId:\s*adminTemplate\.id,\s*resource:\s*"owner_corporate_number",\s*action:\s*"full",\s*granted:\s*true/,
    );
  });

  it("既存の owner_name / owner_address 権限を壊していない", () => {
    expect(seedSrc).toMatch(
      /templateId:\s*fieldStaffTemplate\.id,\s*resource:\s*"owner_name",\s*action:\s*"full"/,
    );
    expect(seedSrc).toMatch(
      /templateId:\s*officeStaffTemplate\.id,\s*resource:\s*"owner_address",\s*action:\s*"full"/,
    );
    expect(seedSrc).toMatch(
      /templateId:\s*adminTemplate\.id,\s*resource:\s*"owner_address",\s*action:\s*"full"/,
    );
  });
});

describe("owner-detail-panel — 法人番号欄 + 候補検出", () => {
  it("法人番号フィールドが追加されている", () => {
    expect(ownerDetailPanelSrc).toMatch(/法人番号/);
  });

  it("候補検出バナーがある", () => {
    expect(ownerDetailPanelSrc).toMatch(/法人番号らしき文字列/);
    expect(ownerDetailPanelSrc).toMatch(/detectCorporateNumberInOwnerLike/);
  });
});
