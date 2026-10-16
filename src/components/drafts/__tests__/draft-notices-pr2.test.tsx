import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { DraftImportPendingNotice, DraftReselectFileNotice } from "../draft-notices";

describe("選び直しの帯", () => {
  it("まだ選んでいないとき: 前回のファイル名を出して選び直しを求める", () => {
    const html = renderToStaticMarkup(createElement(DraftReselectFileNotice, { expectedName: "謄本.pdf", chosenName: null }));
    expect(html).toContain("PDF「謄本.pdf」を選び直してください");
    expect(html).toContain("読み取った結果はそのまま使います");
    expect(html).toContain('data-testid="draft-reselect-notice"');
  });
  it("違う名前を選んだとき: 確かめる一文を出す", () => {
    const html = renderToStaticMarkup(createElement(DraftReselectFileNotice, { expectedName: "a.pdf", chosenName: "b.pdf" }));
    expect(html).toContain("前回と違う名前のファイルです（前回: a.pdf）。同じ書類か確かめてください。");
  });
  it("同じ名前を選んだとき: 何も出さない", () => {
    const html = renderToStaticMarkup(createElement(DraftReselectFileNotice, { expectedName: "a.pdf", chosenName: "a.pdf" }));
    expect(html).toBe("");
  });
});

describe("取り込み途中の帯", () => {
  it("取り込み履歴で確かめるよう案内し、閉じるボタンがある", () => {
    const html = renderToStaticMarkup(createElement(DraftImportPendingNotice, { onDismiss: () => {} }));
    expect(html).toContain("前回、取り込みの途中で画面を離れました。下の「取り込み履歴」で結果を確かめてください。");
    expect(html).toContain("閉じる");
    expect(html).toContain('role="alert"');
  });
});

describe("取り込みの結果が分からない帯(画面に残っているとき・@codex P1)", () => {
  it("履歴で確かめるよう案内し、「確かめたので続ける」で閉じる", () => {
    const html = renderToStaticMarkup(createElement(DraftImportPendingNotice, { onDismiss: () => {}, reason: "unknown" }));
    expect(html).toContain("取り込みの結果が分かりませんでした");
    expect(html).toContain("下の「取り込み履歴」で結果を確かめてから続けてください。");
    expect(html).toContain("確かめたので続ける");
    expect(html).not.toContain("画面を離れました");
  });
});

describe("取り込みの結果が分からない帯: 履歴を読み込み中", () => {
  it("confirmDisabled のときボタンは押せない", () => {
    const html = renderToStaticMarkup(createElement(DraftImportPendingNotice, { onDismiss: () => {}, reason: "unknown", confirmDisabled: true }));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>確かめたので続ける<\/button>/);
    const on = renderToStaticMarkup(createElement(DraftImportPendingNotice, { onDismiss: () => {}, reason: "unknown" }));
    expect(on).not.toMatch(/<button[^>]*disabled=""/);
  });
});

describe("取り込みの結果が分からない帯: 履歴を読み込めなかった", () => {
  it("historyError のとき読み込み直すよう伝える", () => {
    const html = renderToStaticMarkup(
      createElement(DraftImportPendingNotice, { onDismiss: () => {}, reason: "unknown", confirmDisabled: true, historyError: true }),
    );
    expect(html).toContain("取り込み履歴を読み込めませんでした。下の取り込み履歴を読み込み直してから続けてください。");
  });
});

describe("取り込み途中の帯: 取込履歴へ飛べる", () => {
  it("どちらの帯にも「取込履歴を見る」のリンクがある", () => {
    for (const reason of ["left", "unknown"] as const) {
      const html = renderToStaticMarkup(createElement(DraftImportPendingNotice, { onDismiss: () => {}, reason }));
      expect(html).toMatch(/<a href="#import-history"[^>]*>取込履歴を見る<\/a>/);
    }
  });
});
