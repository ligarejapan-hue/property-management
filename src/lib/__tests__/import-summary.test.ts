import { describe, it, expect } from "vitest";
import { calcImportSummary, type ImportRowLike } from "../import-summary";

describe("calcImportSummary", () => {
  it("空配列は全項目 0", () => {
    const s = calcImportSummary([]);
    expect(s).toEqual({
      createdCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      needsReviewCount: 0,
      errorCount: 0,
      totalCount: 0,
    });
  });

  it("success のみは createdCount に集計される", () => {
    const rows: ImportRowLike[] = [
      { status: "success", errorMessage: null },
      { status: "success", errorMessage: null },
      { status: "success", errorMessage: null },
    ];
    const s = calcImportSummary(rows);
    expect(s.createdCount).toBe(3);
    expect(s.updatedCount).toBe(0);
    expect(s.totalCount).toBe(3);
  });

  it("success + 「更新」プレフィックス は updatedCount に集計される", () => {
    const rows: ImportRowLike[] = [
      { status: "success", errorMessage: null }, // 新規
      {
        status: "success",
        errorMessage: "更新[住所一致] (更新項目: 地番, 用途地域)",
      }, // 更新
      {
        status: "success",
        errorMessage: "更新[不動産番号一致]",
      }, // 更新
    ];
    const s = calcImportSummary(rows);
    expect(s.createdCount).toBe(1);
    expect(s.updatedCount).toBe(2);
    expect(s.totalCount).toBe(3);
  });

  it("skipped / needs_review / error が個別に集計される", () => {
    const rows: ImportRowLike[] = [
      { status: "skipped", errorMessage: "重複: 同住所" },
      { status: "skipped", errorMessage: null },
      { status: "needs_review", errorMessage: "重複の可能性" },
      { status: "error", errorMessage: "住所が空です" },
      { status: "error", errorMessage: "棟名が見つかりません" },
    ];
    const s = calcImportSummary(rows);
    expect(s.skippedCount).toBe(2);
    expect(s.needsReviewCount).toBe(1);
    expect(s.errorCount).toBe(2);
    expect(s.createdCount).toBe(0);
    expect(s.updatedCount).toBe(0);
    expect(s.totalCount).toBe(5);
  });

  it("混合シナリオ: 5区分すべてがある", () => {
    const rows: ImportRowLike[] = [
      { status: "success", errorMessage: null }, // 新規
      { status: "success", errorMessage: null }, // 新規
      { status: "success", errorMessage: "更新[住所一致]" }, // 更新
      { status: "skipped", errorMessage: "重複: 既存物件あり" }, // スキップ
      { status: "needs_review", errorMessage: null }, // 要レビュー
      { status: "needs_review", errorMessage: "重複の可能性" }, // 要レビュー
      { status: "error", errorMessage: "住所が空です" }, // エラー
    ];
    const s = calcImportSummary(rows);
    expect(s).toEqual({
      createdCount: 2,
      updatedCount: 1,
      skippedCount: 1,
      needsReviewCount: 2,
      errorCount: 1,
      totalCount: 7,
    });
  });

  it("isUpdateMessage は「更新」で始まる場合だけ true なので、別の文言は createdCount に入る", () => {
    // 「更新候補」「更新予定」など別パターンは isUpdateMessage 仕様で true 扱いになる
    // ことを確認するためのケース。仕様変更時にここで気付けるようガード。
    const rows: ImportRowLike[] = [
      { status: "success", errorMessage: "重複: でも作成" }, // 「更新」始まりではない → created
      { status: "success", errorMessage: "更新候補ではない" }, // 「更新」で始まる → updated
    ];
    const s = calcImportSummary(rows);
    expect(s.createdCount).toBe(1);
    expect(s.updatedCount).toBe(1);
  });

  it("未知のステータスは集計対象外でサイレントに無視される", () => {
    const rows = [
      { status: "success", errorMessage: null },
      // @ts-expect-error - 旧データ互換テスト用に意図的に不正値
      { status: "unknown_legacy", errorMessage: null },
    ] as ImportRowLike[];
    const s = calcImportSummary(rows);
    expect(s.createdCount).toBe(1);
    expect(s.totalCount).toBe(1); // unknown は totalCount にも含めない
  });
});
