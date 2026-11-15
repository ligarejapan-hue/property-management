import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DraftPendingNotice,
  DraftRestoredNotice,
  DraftRebasedNotice,
  DraftTooLargeNotice,
  formatDraftTime,
} from "../draft-notices";

describe("formatDraftTime", () => {
  it("日本時間の H時MM分", () => {
    expect(formatDraftTime(Date.UTC(2026, 9, 13, 1, 5))).toBe("10時05分");
    expect(formatDraftTime(Date.UTC(2026, 9, 13, 15, 30))).toBe("0時30分");
  });
});

describe("帯", () => {
  it("続きの帯: 時刻と「最初からやり直す」", () => {
    const html = renderToStaticMarkup(<DraftRestoredNotice savedAt={Date.UTC(2026, 9, 13, 1, 5)} onDiscard={() => {}} />);
    expect(html).toContain("前回の続きを表示しています（10時05分の入力）");
    expect(html).toContain("最初からやり直す");
    expect(html).toContain('data-testid="draft-restored-notice"');
  });
  it("送信途中の帯", () => {
    const html = renderToStaticMarkup(<DraftPendingNotice onConfirm={() => {}} />);
    expect(html).toContain("前回、登録の途中で画面を離れました。登録されたかどうかを物件一覧で確かめてください。");
    expect(html).toContain("確かめたので続ける");
  });
  it("★控えのあとに物件が更新されていたときの帯(入力は捨てない・2026-11-15)", () => {
    const html = renderToStaticMarkup(<DraftRebasedNotice onDiscard={() => {}} />);
    expect(html).toContain("ほかで更新がありました。入力は残しています（変えた欄だけ、最新の内容に重ねました）。内容を確かめてから保存してください。");
    expect(html).toContain("最初からやり直す");
    expect(html).toContain('data-testid="draft-rebased-notice"');
  });
  it("大きすぎの帯", () => {
    expect(renderToStaticMarkup(<DraftTooLargeNotice />)).toContain("このファイルは大きいため、別の画面へ移ると消えます。");
    expect(renderToStaticMarkup(<DraftTooLargeNotice kind="input" />)).toContain(
      "入力した内容が大きいため、別の画面へ移ると消えます。",
    );
  });
});
