import { describe, it, expect } from "vitest";
import {
  compactPasteDraftForPending,
  isPasteDraftEmpty,
  parsePasteDraft,
  pdfReselectReason,
  type PasteScreenDraft,
} from "../screens/paste";

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
