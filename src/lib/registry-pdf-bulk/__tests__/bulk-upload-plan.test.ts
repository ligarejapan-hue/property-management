import { describe, it, expect } from "vitest";
import {
  classifyBulkFiles,
  planBatches,
  bulkFileKey,
  filterUnsent,
  buildUploadPlan,
  MAX_BULK_FILE_BYTES,
  type BulkFileMeta,
} from "../bulk-upload-plan";

const meta = (name: string, size = 1024): BulkFileMeta => ({ name, size });
const pdfs = (n: number, size = 1024): BulkFileMeta[] =>
  Array.from({ length: n }, (_, i) => meta(`f${i}.pdf`, size));

describe("classifyBulkFiles", () => {
  it(".pdf は大文字小文字問わず送信可、非PDFは not_pdf 除外", () => {
    const files = [meta("a.pdf"), meta("b.PDF"), meta("c.xlsx"), meta("d.txt")];
    const { sendable, excluded } = classifyBulkFiles(files);
    expect(sendable).toEqual([0, 1]);
    expect(excluded).toEqual([
      { index: 2, name: "c.xlsx", reason: "not_pdf" },
      { index: 3, name: "d.txt", reason: "not_pdf" },
    ]);
  });

  it("ちょうど5MBは送信可、5MB+1は too_large", () => {
    const files = [
      meta("ok.pdf", MAX_BULK_FILE_BYTES),
      meta("big.pdf", MAX_BULK_FILE_BYTES + 1),
    ];
    const { sendable, excluded } = classifyBulkFiles(files);
    expect(sendable).toEqual([0]);
    expect(excluded).toEqual([
      { index: 1, name: "big.pdf", reason: "too_large" },
    ]);
  });
});

describe("planBatches", () => {
  it("空入力は空配列", () => {
    expect(planBatches([], [])).toEqual([]);
  });

  it("100件は1バッチ、101件は2バッチ(100+1)", () => {
    const files = pdfs(101);
    const idx = files.map((_, i) => i);
    const b100 = planBatches(idx.slice(0, 100), files);
    expect(b100).toHaveLength(1);
    expect(b100[0]).toHaveLength(100);
    const b101 = planBatches(idx, files);
    expect(b101).toHaveLength(2);
    expect(b101[0]).toHaveLength(100);
    expect(b101[1]).toEqual([100]);
  });

  it("合計が90MB目標を跨ぐ位置で分割", () => {
    const mb = 1024 * 1024;
    const files = [
      meta("a.pdf", 40 * mb),
      meta("b.pdf", 40 * mb),
      meta("c.pdf", 40 * mb),
    ];
    expect(planBatches([0, 1, 2], files)).toEqual([[0, 1], [2]]);
  });
});

describe("bulkFileKey", () => {
  it("規約ファイル名は請求番号、非規約はファイル名", () => {
    expect(
      bulkFileKey("渋谷区A不動産登記（建物所有者事項）2024121200118150.PDF"),
    ).toBe("2024121200118150");
    expect(bulkFileKey("random.pdf")).toBe("random.pdf");
  });
});

describe("filterUnsent / buildUploadPlan", () => {
  it("送信済みキーを除外する", () => {
    const files = [
      meta("渋谷区A不動産登記（土地所有者事項）1111111111111111.pdf"),
      meta("渋谷区B不動産登記（建物所有者事項）2222222222222222.pdf"),
    ];
    expect(filterUnsent([0, 1], files, new Set(["1111111111111111"]))).toEqual([
      1,
    ]);
  });

  it("buildUploadPlan は除外・送信済み・バッチを集計", () => {
    const files = [
      meta("渋谷区A不動産登記（土地所有者事項）1111111111111111.pdf"),
      meta("big.pdf", MAX_BULK_FILE_BYTES + 1),
      meta("note.txt"),
      meta("渋谷区B不動産登記（建物所有者事項）2222222222222222.pdf"),
    ];
    const plan = buildUploadPlan(files, new Set(["1111111111111111"]));
    expect(plan.excluded.map((x) => x.reason)).toEqual(["too_large", "not_pdf"]);
    expect(plan.alreadySentCount).toBe(1);
    expect(plan.sendableTotal).toBe(1);
    expect(plan.batches).toEqual([[3]]);
  });
});
