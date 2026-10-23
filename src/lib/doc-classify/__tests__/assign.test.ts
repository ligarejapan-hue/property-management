import { describe, it, expect } from "vitest";
import { docColumnsForManualKind, docColumnsForNewAttachment } from "../assign";

const ctx = {
  property: { buildingName: "ハマイハイライズ", roomNo: "305号室", address: "東京都…" },
  takenTitles: new Set<string>(),
};
const NOW = new Date(2026, 9, 23, 12, 0, 0); // 端末時刻 2026-10-23

describe("docColumnsForNewAttachment", () => {
  it("名前で当たれば4列がそろい、日付は今日", () => {
    const c = docColumnsForNewAttachment({ fileName: "【完成版】売買契約書.pdf", now: NOW }, ctx);
    expect(c).toEqual({
      docStage: "contract",
      docKind: "sales_contract",
      docTitle: "売買契約書_ハマイハイライズ305_20261023.pdf",
      docConfidence: "high",
    });
  });

  it("本文に日付があればそれを名前に使う", () => {
    const c = docColumnsForNewAttachment(
      { fileName: "scan.pdf", text: "付帯設備表\n作成日 令和8年9月30日", now: NOW },
      ctx,
    );
    expect(c.docKind).toBe("fixtures_list");
    expect(c.docTitle).toBe("付帯設備表_ハマイハイライズ305_20260930.pdf");
  });

  it("同じ名前が既にあれば _2", () => {
    const c = docColumnsForNewAttachment(
      { fileName: "売買契約書.pdf", now: NOW },
      { ...ctx, takenTitles: new Set(["売買契約書_ハマイハイライズ305_20261023.pdf"]) },
    );
    expect(c.docTitle).toBe("売買契約書_ハマイハイライズ305_20261023_2.pdf");
  });

  it("当たらなければ4列とも null(その他・元の名前のまま)", () => {
    expect(docColumnsForNewAttachment({ fileName: "IMG_1.jpg", now: NOW }, ctx)).toEqual({
      docStage: null, docKind: null, docTitle: null, docConfidence: null,
    });
  });
});

describe("docColumnsForManualKind", () => {
  it("人が決めた種類で名前を作り直し、日付は今の名前の日付を引き継ぐ", () => {
    const c = docColumnsForManualKind(
      { kindCode: "disclosure", fileName: "x.pdf", currentTitle: "売買契約書_ハマイハイライズ305_20260901.pdf", createdAt: NOW },
      ctx,
    );
    expect(c).toEqual({
      docStage: "contract",
      docKind: "disclosure",
      docTitle: "重要事項説明書_ハマイハイライズ305_20260901.pdf",
      docConfidence: "manual",
    });
  });

  it("名前に日付が無ければ登録日", () => {
    const c = docColumnsForManualKind({ kindCode: "settlement_notice", fileName: "a.pdf", currentTitle: null, createdAt: NOW }, ctx);
    expect(c.docTitle).toBe("決済のご案内_ハマイハイライズ305_20261023.pdf");
  });

  it("null(その他)なら4列とも null", () => {
    expect(docColumnsForManualKind({ kindCode: null, fileName: "a.pdf", currentTitle: "x", createdAt: NOW }, ctx)).toEqual({
      docStage: null, docKind: null, docTitle: null, docConfidence: null,
    });
  });

  it("知らない種類は null 扱い(route 側で 422 にする前提)", () => {
    expect(docColumnsForManualKind({ kindCode: "nope", fileName: "a.pdf", currentTitle: null, createdAt: NOW }, ctx).docKind).toBeNull();
  });
});
