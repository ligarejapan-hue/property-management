import { describe, it, expect } from "vitest";
import {
  compactPasteDraftForPending,
  isPasteDraftEmpty,
  parsePasteDraft,
  pdfReselectReason,
  type PasteScreenDraft,
} from "../screens/paste";
import {
  isPasteExcelDraftEmpty,
  parsePasteExcelDraft,
  restoreExcelResults,
} from "../screens/paste-excel";

const review = {
  draft: { noteFromUnmapped: "", unreadable: [], property: {}, owner: null, externalLinkKey: null },
  duplicates: { blocked: false, blockedByPropertyId: null, similarPropertyIds: [] },
  similar: [{ id: "p1" }],
  ownerCandidates: [{ id: "o1", matchKind: "name_only" }],
  ownerCandidatesTruncated: false,
  extractedText: null,
  propertyValues: { address: "東京都港区1-1" },
  ownerValues: { name: "山田", nameKana: "", phone: "", email: "", currentAddress: "" },
  note: "メモ",
  externalLinkKey: "",
  ownerMode: "new",
  linkedOwner: null,
  buildingChoice: { kind: "auto" },
};

const full = { rev: 1, rawText: "お名前：山田", pdfFileName: null, review } as unknown as PasteScreenDraft;

describe("貼り付けて物件化の控え", () => {
  it("往復して同じ", () => {
    expect(parsePasteDraft(JSON.parse(JSON.stringify(full)))).toEqual(full);
  });
  it("rev が違う・欠けた欄は捨てる(配布で形が変わった後の控え)", () => {
    expect(parsePasteDraft({ ...full, rev: 2 })).toBeNull();
    const noNote: Partial<typeof review> = { ...review };
    delete noNote.note;
    expect(parsePasteDraft({ ...full, review: noNote })).toBeNull();
    expect(parsePasteDraft({ ...full, review: { ...review, ownerMode: "x" } })).toBeNull();
    expect(parsePasteDraft(null)).toBeNull();
  });
  it("貼った文章も読み取り結果も無ければ空", () => {
    expect(isPasteDraftEmpty({ rev: 1, rawText: "  ", pdfFileName: null, review: null })).toBe(true);
    expect(isPasteDraftEmpty({ rev: 1, rawText: "a", pdfFileName: null, review: null })).toBe(false);
    expect(isPasteDraftEmpty({ ...full, rawText: "" })).toBe(false);
  });
  it("送信中の印だけを残す中身は空", () => {
    expect(isPasteDraftEmpty(compactPasteDraftForPending())).toBe(true);
  });
  it("PDFで読み取った確認画面を戻したときだけ、選び直すまで登録を止める", () => {
    expect(pdfReselectReason({ hasReview: true, pdfFileName: "a.pdf", hasPdfFile: false })).toBe("PDF「a.pdf」を選び直してください");
    expect(pdfReselectReason({ hasReview: true, pdfFileName: "a.pdf", hasPdfFile: true })).toBeNull();
    expect(pdfReselectReason({ hasReview: true, pdfFileName: null, hasPdfFile: false })).toBeNull();
    expect(pdfReselectReason({ hasReview: false, pdfFileName: "a.pdf", hasPdfFile: false })).toBeNull();
  });
});

describe("Excelまとめ取込の控え", () => {
  const row = {
    sheetName: "HOME4U", rowNumber: 3, text: "お名前：山田", draft: { noteFromUnmapped: "" },
    ownerNote: "", status: "ready", reasons: [], registeredPropertyId: null,
  };
  const d = { rev: 1, fileName: "表.xlsx", rows: [row], results: { "HOME4U#3": { kind: "created", propertyId: "p1" } }, sendingKey: null };

  it("往復して同じ・形違いは捨てる", () => {
    expect(parsePasteExcelDraft(JSON.parse(JSON.stringify(d)))).toEqual(d);
    expect(parsePasteExcelDraft({ ...d, rev: 2 })).toBeNull();
    expect(parsePasteExcelDraft({ ...d, results: { x: { kind: "nope" } } })).toBeNull();
    expect(parsePasteExcelDraft({ ...d, rows: [{ ...row, status: "x" }] })).toBeNull();
  });
  it("行が無ければ空", () => {
    expect(isPasteExcelDraftEmpty({ rev: 1, fileName: "a.xlsx", rows: [], results: {}, sendingKey: null })).toBe(true);
    expect(isPasteExcelDraftEmpty(d as never)).toBe(false);
  });

  // 総当たり: 送信中の行の有無 × その行の結果の有無 × 他の行の結果
  const cases: Array<[string, Record<string, { kind: string }>, string | null, Record<string, string>]> = [
    ["送信中なし", { a: { kind: "created" } }, null, { a: "created" }],
    ["送信中の行は結果なし→unknown", {}, "b", { b: "unknown" }],
    ["送信中の行に結果が届いていればそのまま", { b: { kind: "failed" } }, "b", { b: "failed" }],
    ["他の行の結果は残す", { a: { kind: "duplicate" } }, "b", { a: "duplicate", b: "unknown" }],
  ];
  it.each(cases)("%s", (_n, results, sending, expected) => {
    const out = restoreExcelResults(results as never, sending);
    expect(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.kind]))).toEqual(expected);
  });
});

import {
  compactRegistryPdfDraftForPending,
  isRegistryPdfDraftEmpty,
  parseRegistryPdfDraft,
  registryNeedsReselect,
} from "../screens/registry-pdf";

describe("謄本PDF取込の控え", () => {
  const d = {
    rev: 1, step: "confirm", uploadTab: "file", text: "", fileName: "謄本.pdf", fromFile: true,
    fields: { address: { value: "東京都", confidence: "high" } },
    owners: [{ name: "山田", address: "", share: "" }], warnings: [], isLikelyScanned: false,
    embeddedTextLength: 1200, target: "existing", existingPropertyId: "p1", propertySearchQuery: "港区",
    existingProperty: { id: "p1", address: "港区1-1", lotNumber: null, realEstateNumber: null },
  };
  it("往復して同じ・形違いは捨てる", () => {
    expect(parseRegistryPdfDraft(JSON.parse(JSON.stringify(d)))).toEqual(d);
    expect(parseRegistryPdfDraft({ ...d, step: "result" })).toBeNull();
    expect(parseRegistryPdfDraft({ ...d, fields: { a: { value: "x", confidence: "?" } } })).toBeNull();
    expect(parseRegistryPdfDraft({ ...d, rev: 2 })).toBeNull();
  });
  it("最初の段階で文章も無ければ空(ファイルだけ選んだ状態は戻せないので控えない)", () => {
    const empty = compactRegistryPdfDraftForPending();
    expect(isRegistryPdfDraftEmpty(empty)).toBe(true);
    expect(isRegistryPdfDraftEmpty({ ...empty, fileName: "a.pdf", fromFile: true })).toBe(true);
    expect(isRegistryPdfDraftEmpty({ ...empty, text: "所在" })).toBe(false);
    expect(isRegistryPdfDraftEmpty(d as never)).toBe(false);
  });
  it.each([
    ["upload", "file", true, false, false],
    ["extract", "file", true, false, true],
    ["confirm", "file", true, false, true],
    ["confirm", "file", true, true, false],
    ["confirm", "text", false, false, false],
  ] as const)("段階 %s・%s・ファイルで読んだ=%s・ファイルあり=%s → 選び直し=%s", (step, uploadTab, fromFile, hasFile, expected) => {
    expect(registryNeedsReselect({ step, uploadTab, fromFile, hasFile })).toBe(expected);
  });
});
