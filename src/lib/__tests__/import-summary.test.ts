import { describe, it, expect } from "vitest";
import {
  calcImportSummary,
  summaryFromStatusCounts,
  type ImportRowLike,
  type StatusCounts,
} from "../import-summary";
import { isUpdateMessage } from "../import-row-display";

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
      // 旧データ互換: enum 外の status。配列を ImportRowLike[] にアサートしているため
      // 個々の literal は型エラーにならない（旧 @ts-expect-error は unused のため削除）。
      { status: "unknown_legacy", errorMessage: null },
    ] as ImportRowLike[];
    const s = calcImportSummary(rows);
    expect(s.createdCount).toBe(1);
    expect(s.totalCount).toBe(1); // unknown は totalCount にも含めない
  });
});

// ---------------------------------------------------------------------------
// summaryFromStatusCounts（一覧 route の groupBy 集約版）
//
// 一覧 route は全行 findMany + JS 集計を廃し、DB の groupBy 結果から
// summaryFromStatusCounts でサマリを組む。旧 calcImportSummary と「同じ行集合」
// から作ったサマリが完全一致する（parity）ことを保証するのがこのスイートの主眼。
// ---------------------------------------------------------------------------

/**
 * row fixture から groupBy(by:["jobId","status"]) 相当の status 別件数を作る。
 * DB enum 上 unknown status は存在し得ない（= groupBy も返さない）が、テストでは
 * unknown を混ぜても summaryFromStatusCounts が無視することを確認するため、
 * 出現した status をそのまま数える。
 */
function statusCountsFromRows(rows: ImportRowLike[]): StatusCounts {
  const counts: Record<string, number> = {};
  for (const r of rows) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
  }
  return counts;
}

/**
 * row fixture から groupBy(②: status="success" & errorMessage startsWith"更新")
 * 相当の更新件数を作る。判定は route の where と同じ isUpdateMessage 規約。
 */
function updatedCountFromRows(rows: ImportRowLike[]): number {
  return rows.filter(
    (r) => r.status === "success" && isUpdateMessage(r.errorMessage),
  ).length;
}

/** 同じ row fixture から旧実装と新実装の出力が完全一致することを表明する。 */
function expectParity(rows: ImportRowLike[]) {
  const legacy = calcImportSummary(rows);
  const aggregated = summaryFromStatusCounts(
    statusCountsFromRows(rows),
    updatedCountFromRows(rows),
  );
  expect(aggregated).toEqual(legacy);
}

describe("summaryFromStatusCounts — calcImportSummary との parity", () => {
  it("空", () => {
    expectParity([]);
  });

  it("全新規（success / errorMessage は更新でない）", () => {
    expectParity([
      { status: "success", errorMessage: null },
      { status: "success", errorMessage: "新規作成" },
      { status: "success", errorMessage: null },
    ]);
  });

  it("全更新（success / errorMessage が「更新」始まり）", () => {
    expectParity([
      { status: "success", errorMessage: "更新[住所一致]" },
      { status: "success", errorMessage: "更新[不動産番号一致] (更新項目: 地番)" },
    ]);
  });

  it("新規 / 更新 混在", () => {
    expectParity([
      { status: "success", errorMessage: null }, // 新規
      { status: "success", errorMessage: "更新[住所一致]" }, // 更新
      { status: "success", errorMessage: "重複だが作成" }, // 新規
      { status: "success", errorMessage: "更新候補" }, // 更新（「更新」始まり）
    ]);
  });

  it("skipped", () => {
    expectParity([
      { status: "skipped", errorMessage: "重複: 同住所" },
      { status: "skipped", errorMessage: null },
    ]);
  });

  it("needs_review", () => {
    expectParity([
      { status: "needs_review", errorMessage: "重複の可能性" },
      { status: "needs_review", errorMessage: null },
      { status: "needs_review", errorMessage: "要確認" },
    ]);
  });

  it("error", () => {
    expectParity([
      { status: "error", errorMessage: "住所が空です" },
      { status: "error", errorMessage: "棟名が見つかりません" },
    ]);
  });

  it("errorMessage = null（success の null は新規扱い・更新にしない）", () => {
    expectParity([
      { status: "success", errorMessage: null },
      { status: "success", errorMessage: null },
      { status: "skipped", errorMessage: null },
      { status: "needs_review", errorMessage: null },
      { status: "error", errorMessage: null },
    ]);
  });

  it("「更新」以外の success message は createdCount に入る", () => {
    expectParity([
      { status: "success", errorMessage: "重複: でも作成" }, // 新規
      { status: "success", errorMessage: "作成しました" }, // 新規
      { status: "success", errorMessage: "  更新（先頭空白）" }, // 先頭空白 → 「更新」始まりでない → 新規
    ]);
  });

  it("5区分すべてが揃う混合シナリオ", () => {
    expectParity([
      { status: "success", errorMessage: null },
      { status: "success", errorMessage: null },
      { status: "success", errorMessage: "更新[住所一致]" },
      { status: "skipped", errorMessage: "重複: 既存物件あり" },
      { status: "needs_review", errorMessage: null },
      { status: "needs_review", errorMessage: "重複の可能性" },
      { status: "error", errorMessage: "住所が空です" },
    ]);
  });

  it("unknown status は両実装とも集計対象外（parity 維持）", () => {
    const rows = [
      { status: "success", errorMessage: null },
      { status: "success", errorMessage: "更新[住所一致]" },
      // 旧データ互換: enum 外の status。配列アサートにより literal は型エラーにならない。
      { status: "unknown_legacy", errorMessage: null },
    ] as ImportRowLike[];
    expectParity(rows);
  });
});

describe("summaryFromStatusCounts — 単体仕様", () => {
  it("未指定 status は 0 埋めされる", () => {
    const s = summaryFromStatusCounts({ success: 5 }, 2);
    expect(s).toEqual({
      createdCount: 3, // 5 - 2
      updatedCount: 2,
      skippedCount: 0,
      needsReviewCount: 0,
      errorCount: 0,
      totalCount: 5,
    });
  });

  it("空オブジェクトは全項目 0", () => {
    expect(summaryFromStatusCounts({}, 0)).toEqual({
      createdCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      needsReviewCount: 0,
      errorCount: 0,
      totalCount: 0,
    });
  });

  it("全 status 指定時に createdCount = success - updated で算出される", () => {
    const s = summaryFromStatusCounts(
      { success: 10, skipped: 2, needs_review: 1, error: 3 },
      4,
    );
    expect(s).toEqual({
      createdCount: 6, // 10 - 4
      updatedCount: 4,
      skippedCount: 2,
      needsReviewCount: 1,
      errorCount: 3,
      totalCount: 16, // 6 + 4 + 2 + 1 + 3
    });
  });

  it("updatedCount は success 総数を超えないようクランプされる（競合スナップショット保険）", () => {
    const s = summaryFromStatusCounts({ success: 2 }, 5);
    expect(s.updatedCount).toBe(2);
    expect(s.createdCount).toBe(0);
    expect(s.totalCount).toBe(2);
  });

  it("負の updatedCount は 0 にクランプされる", () => {
    const s = summaryFromStatusCounts({ success: 3 }, -1);
    expect(s.updatedCount).toBe(0);
    expect(s.createdCount).toBe(3);
    expect(s.totalCount).toBe(3);
  });

  it("pending は5区分の集計に含まれない（registry_pdf_bulk 由来の未処理行として無視）", () => {
    const s = summaryFromStatusCounts(
      { success: 3, skipped: 1, needs_review: 1, error: 1, pending: 4 },
      0,
    );
    expect(s).toEqual({
      createdCount: 3,
      updatedCount: 0,
      skippedCount: 1,
      needsReviewCount: 1,
      errorCount: 1,
      totalCount: 6, // pending の4件は含まれない
    });
  });

  it("pending のみ（他 status 0件）は全項目 0", () => {
    const s = summaryFromStatusCounts({ pending: 5 }, 0);
    expect(s).toEqual({
      createdCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      needsReviewCount: 0,
      errorCount: 0,
      totalCount: 0,
    });
  });
});
