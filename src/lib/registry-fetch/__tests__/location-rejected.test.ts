/**
 * 「所在が受け付けられなかった」の検出。
 *
 * 2026-08-04 実機で判明した最悪の挙動を防ぐためのテスト:
 * サイトは赤字で「請求できない所在です…」と理由を出しているのに、こちらは候補
 * チェックボックスの有無しか見ておらず「**候補が見つかりませんでした (0 件)**」と
 * 報告していた。例外を投げないので journald にも何も残らず、**利用者は「登記の無い
 * 物件」と誤解し、開発側も原因に辿り着けない**(実際に丸一日ぶんの診断を要した)。
 */
import { describe, it, expect, vi } from "vitest";

// auto-fetch は prisma / api-helpers を引き込む（playwright-adapter.test.ts と同じ前処理）。
vi.mock("@/lib/prisma", () => ({ default: {} }));
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return { ApiError: MockApiError };
});

import { looksLocationRejected } from "../auto-fetch";
import { REGISTRY_FETCH_ERROR_MESSAGES } from "../errors";

/**
 * 実機で採取した赤字(2026-08-04)。
 * ⚠**実在の物件所在は書かない**(@codex #355 P1)。サイトの固定文言のみを写し、
 * 住所を要する例は公開の商業地(千代田区丸の内一丁目)に置き換える。
 */
const REAL_REJECTION_TEXT = [
  "・請求できない所在です（入力が誤っている又は、所在に外字が含まれているか又は、入力が不要な小字が含まれている等）。",
  "所在を手入力している又は地番検索サービスから送信した場合、修正が必要な可能性があります。",
  "直接入力のチェックを外し、所在選択ボタンをクリックし、ダイアログから所在を選択してください。",
  "▼ 検索範囲を指定し、表示された地番・家屋番号を選択してください。50件まで選択できます。",
].join("\n");

describe("looksLocationRejected — 実機の文言を確実に拾う", () => {
  it("実際に出た赤字を検出する", () => {
    expect(looksLocationRejected(REAL_REJECTION_TEXT)).toBe(true);
  });

  it("3つの目印はどれ単独でも検出できる(サイト文言の一部変更に耐える)", () => {
    for (const s of [
      "請求できない所在です",
      "所在に外字が含まれているか",
      "所在選択ボタンをクリックし",
    ]) {
      expect(looksLocationRejected(s)).toBe(true);
    }
  });

  it("⚠正常時の画面では検出しない(候補が出ているのに失敗扱いにしない)", () => {
    // ダイアログの見出し・ラベルには「所在」「種別」が普通に出る。
    const normal = [
      "地番・家屋番号一覧",
      "種別 土地",
      "所在 東京都千代田区丸の内一丁目",
      "▼ 検索範囲を指定し、表示された地番・家屋番号を選択してください。50件まで選択できます。",
      "選択件数：3 件",
      "地番・家屋番号",
      "1-1",
    ].join("\n");
    expect(looksLocationRejected(normal)).toBe(false);
  });

  it("空文字・無関係な文面では検出しない", () => {
    expect(looksLocationRejected("")).toBe(false);
    expect(looksLocationRejected("ログインしました")).toBe(false);
    expect(looksLocationRejected("候補は見つかりませんでした")).toBe(false);
  });
});

describe("利用者に出る文言", () => {
  const msg = REGISTRY_FETCH_ERROR_MESSAGES.location_rejected;

  it("「0件」と言い切らず、原因と次の手を書く", () => {
    expect(msg).toContain("受け付けませんでした");
    expect(msg).toContain("地番");
    expect(msg).toContain("丁目まで");
    // 「見つかりませんでした」は候補ゼロの文言。混同させない。
    expect(msg).not.toContain("見つかりませんでした");
  });

  it("⚠所在そのものを載せない(固定文言=PIIを持ち出さない設計)", () => {
    // 例示は一般的な形式のみ。実在の住所・地番を文言に埋めない。
    expect(msg).not.toMatch(/[都道府県]{1}[^。]{0,10}[市区町村]/);
  });
});
