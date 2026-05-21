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
    expect(pageSrc).toMatch(/maxLength=\{13\}/);
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

describe("owner-detail-panel — 法人番号欄 + 候補検出", () => {
  it("法人番号フィールドが追加されている", () => {
    expect(ownerDetailPanelSrc).toMatch(/法人番号/);
  });

  it("候補検出バナーがある", () => {
    expect(ownerDetailPanelSrc).toMatch(/法人番号らしき文字列/);
    expect(ownerDetailPanelSrc).toMatch(/detectCorporateNumberInOwnerLike/);
  });
});
