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

import {
  compactCsvImportDraftForPending,
  csvDraftAfterImport,
  decideCsvImportRestore,
  INITIAL_CSV_PENDING,
  nextCsvPending,
  type CsvPendingEvent,
  isCsvImportDraftEmpty,
  parseCsvImportDraft,
} from "../screens/csv-import";

describe("取り込み(CSV)の控え", () => {
  const main = {
    step: 2, fileName: "a.csv", csvText: "住所\n東京", xlsxBase64: null, template: "standard",
    headers: ["住所"], rows: [["東京"]], columnMapping: { 住所: "address" }, duplicatePreview: null,
  };
  const file = { name: "受付帳.csv", csvText: "x" };
  const d = {
    rev: 1, main,
    ro: { receptionFile: file, ownerFile: null, dlFilter: "marked", shinkiFilter: "existing", roPreview: null },
    rp: null,
  };
  it("往復して同じ・形違いは捨てる", () => {
    expect(parseCsvImportDraft(JSON.parse(JSON.stringify(d)))).toEqual(d);
    expect(parseCsvImportDraft({ ...d, main: { ...main, step: 4 } })).toBeNull();
    expect(parseCsvImportDraft({ ...d, ro: { ...d.ro, dlFilter: "x" } })).toBeNull();
    expect(parseCsvImportDraft({ ...d, rev: 2 })).toBeNull();
  });
  it("3つの流れのどれも無ければ空", () => {
    expect(isCsvImportDraftEmpty(compactCsvImportDraftForPending())).toBe(true);
    expect(isCsvImportDraftEmpty({ rev: 1, main: null, ro: null, rp: { rpFile: file, rpDlFilter: "marked", rpShinkiFilter: "existing", rpPreview: null } } as never)).toBe(false);
  });
  it("送信中の印が残っていたら、中身は戻さず案内だけ出す(§5.1 S4)", () => {
    const data = parseCsvImportDraft(d)!;
    expect(decideCsvImportRestore({ v: 1, savedAt: 1, data, pendingSubmit: { at: 1 } })).toEqual({ start: null, showPending: true });
    expect(decideCsvImportRestore({ v: 1, savedAt: 1, data })).toEqual({ start: data, showPending: false });
    expect(decideCsvImportRestore(null)).toEqual({ start: null, showPending: false });
  });
});

describe("取り込み(CSV)が済んだ後の控え(最終点検 Important #1)", () => {
  const file = { name: "受付帳.csv", csvText: "x" };
  const d = {
    rev: 1 as const,
    main: {
      step: 3 as const, fileName: "a.csv", csvText: "住所\n東京", xlsxBase64: null, template: "standard",
      headers: ["住所"], rows: [["東京"]], columnMapping: {}, duplicatePreview: null,
    },
    ro: { receptionFile: file, ownerFile: file, dlFilter: "marked" as const, shinkiFilter: "existing" as const, roPreview: null },
    rp: { rpFile: file, rpDlFilter: "marked" as const, rpShinkiFilter: "existing" as const, rpPreview: null },
  };
  it("取り込んだ流れだけを外し、他の流れは残す(画面を離れた後に済んでも再送できる形で残さない)", () => {
    expect(csvDraftAfterImport(d, "main")).toEqual({ ...d, main: null });
    expect(csvDraftAfterImport(d, "ro")).toEqual({ ...d, ro: null });
    expect(csvDraftAfterImport(d, "rp")).toEqual({ ...d, rp: null });
  });
});

describe("取り込み(CSV)の送信中の印の数え方(@codex P1 2件)", () => {
  const run = (events: CsvPendingEvent[]) =>
    events.reduce(
      (acc, e) => {
        const r = nextCsvPending(acc.state, e);
        return { state: r.state, unmarks: [...acc.unmarks, r.unmark] };
      },
      { state: INITIAL_CSV_PENDING, unmarks: [] as boolean[] },
    );
  it("1つ送って済めば印を外す", () => {
    expect(run(["start", "ok"]).unmarks).toEqual([false, true]);
    expect(run(["start", "definite"]).unmarks).toEqual([false, true]);
  });
  it("2つの流れを同時に送ったら、両方済むまで印を外さない", () => {
    expect(run(["start", "start", "ok", "ok"]).unmarks).toEqual([false, false, false, true]);
    expect(run(["start", "start", "definite", "ok"]).unmarks).toEqual([false, false, false, true]);
  });
  it("結果が分からない(5xx・通信切れ)ときは、人が確かめるまで印を外さず、送れなくする", () => {
    const r = run(["start", "unknown"]);
    expect(r.unmarks).toEqual([false, false]);
    expect(r.state.unknown).toBe(true);
    // 別の流れが後から済んでも外さない
    const r2 = run(["start", "start", "unknown", "ok"]);
    expect(r2.unmarks).toEqual([false, false, false, false]);
    expect(r2.state.unknown).toBe(true);
  });
  it("確かめたら(続ける)、送っているものが無ければ印を外す。送っている途中なら外さない", () => {
    expect(run(["start", "unknown", "confirm"]).unmarks).toEqual([false, false, true]);
    const r = run(["start", "start", "unknown", "confirm"]);
    expect(r.unmarks).toEqual([false, false, false, false]);
    expect(r.state).toEqual({ inflight: 1, unknown: false });
    expect(run(["start", "start", "unknown", "confirm", "ok"]).unmarks.at(-1)).toBe(true);
  });
  it("数は0より下がらない", () => {
    expect(run(["ok"]).state.inflight).toBe(0);
  });
});

import { canTrustJobHistory, HISTORY_SETTLE_MS, initialHistoryReadyAt } from "../screens/csv-import";

describe("取り込み履歴を「確かめた」根拠にしてよいか(@codex P1: サーバーがまだジョブを作る前の履歴で確かめさせない)", () => {
  const base = { sameGen: true, defaultView: true, startedAt: 10_000, readyAt: 10_000 };
  it("落ち着く時刻の後に始めた・絞り込みなしの1ページ目・最新の世代なら使える", () => {
    expect(canTrustJobHistory(base)).toBe(true);
    expect(canTrustJobHistory({ ...base, startedAt: 70_000 })).toBe(true);
  });
  it("落ち着く前に始めた読み込みは使わない(サーバーが表を読み終える前かもしれない)", () => {
    expect(canTrustJobHistory({ ...base, startedAt: 9_999 })).toBe(false);
  });
  it("古い世代・絞り込みありは使わない", () => {
    expect(canTrustJobHistory({ ...base, sameGen: false })).toBe(false);
    expect(canTrustJobHistory({ ...base, defaultView: false })).toBe(false);
  });
  it("前回離れたときは、印を付けた時刻から待つ・印が無ければ待たない", () => {
    expect(initialHistoryReadyAt({ v: 1, savedAt: 1, data: {} as never, pendingSubmit: { at: 5_000 } })).toBe(5_000 + HISTORY_SETTLE_MS);
    expect(initialHistoryReadyAt({ v: 1, savedAt: 1, data: {} as never })).toBe(0);
    expect(initialHistoryReadyAt(null)).toBe(0);
    expect(HISTORY_SETTLE_MS).toBe(60_000);
  });
});

import { isRegistryImportResult } from "../screens/registry-pdf";

describe("謄本の取り込みの成功の返事の形(@codex P2: 結果の画面が描くものを全部確かめる)", () => {
  const parsed = {
    realEstateNumber: null, address: "東京都", lotNumber: "1-2", buildingNumber: null, landCategory: null, area: null,
    owners: [{ name: "山田", address: null, share: null }], confidence: 0.9, warnings: ["注意"],
  };
  const ok = { jobId: "ij-1", action: "created", propertyId: "p1", parsed };
  it("そろっていれば結果として扱う(物件番号なし・警告ありも)", () => {
    expect(isRegistryImportResult(ok)).toBe(true);
    expect(isRegistryImportResult({ ...ok, propertyId: null, warning: "PDF本体は保存しませんでした" })).toBe(true);
  });
  it("入れ子の中身の形が違えば分からない扱い", () => {
    expect(isRegistryImportResult({ ...ok, parsed: {} })).toBe(false);
    expect(isRegistryImportResult({ ...ok, parsed: { ...parsed, warnings: [{}] } })).toBe(false);
    expect(isRegistryImportResult({ ...ok, parsed: { ...parsed, owners: [{}] } })).toBe(false);
    expect(isRegistryImportResult({ ...ok, parsed: { ...parsed, address: {} } })).toBe(false);
    expect(isRegistryImportResult({ ...ok, action: {} })).toBe(false);
    expect(isRegistryImportResult({ ...ok, jobId: "" })).toBe(false);
    expect(isRegistryImportResult({ ...ok, warning: {} })).toBe(false);
    expect(isRegistryImportResult({})).toBe(false);
  });
});
