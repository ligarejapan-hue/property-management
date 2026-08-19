/**
 * 請求(課金)の確認ゲートの挙動テスト。
 * 第7回テスト(2026-08-19・課金ゼロ)とサイトJSの実測から作った規則を固定する。
 */
import { describe, expect, it } from "vitest";

import {
  dialogAmountMatches,
  parseYenAmount,
  pickConfirmButtonIndex,
  resolveSeikyuConfirm,
  SEIKYU_CONFIRM_CANCEL_LABELS,
} from "@/lib/registry-fetch/seikyu-confirm";

describe("parseYenAmount", () => {
  it("カンマ・全角・円つきでも数値にする", () => {
    expect(parseYenAmount("140")).toBe(140);
    expect(parseYenAmount("1,400")).toBe(1400);
    expect(parseYenAmount("１４０ 円")).toBe(140);
    expect(parseYenAmount(" 140円 ")).toBe(140);
  });

  it("数字が無ければ null(読めないものを0円と誤解しない)", () => {
    expect(parseYenAmount("")).toBeNull();
    expect(parseYenAmount("—")).toBeNull();
    expect(parseYenAmount("読み込み中")).toBeNull();
  });
});

describe("resolveSeikyuConfirm(課金前の合計一致ゲート)", () => {
  it("行の料金と請求金額合計が一致したときだけ進む", () => {
    expect(resolveSeikyuConfirm({ rowFeeText: "140", totalText: "140" })).toEqual({
      proceed: true,
      amountYen: 140,
    });
  });

  it("⚠合計が行の料金より多い(選択が増えている)ら課金前に止める", () => {
    const d = resolveSeikyuConfirm({ rowFeeText: "140", totalText: "280" });
    expect(d.proceed).toBe(false);
    if (!d.proceed) {
      expect(d.reason).toBe("amount-mismatch");
      expect(d.detail).toContain("280");
      expect(d.detail).toContain("140");
    }
  });

  it("⚠どちらかが読めなければ進まない(fail-closed)", () => {
    expect(
      resolveSeikyuConfirm({ rowFeeText: "140", totalText: "" }).proceed,
    ).toBe(false);
    expect(
      resolveSeikyuConfirm({ rowFeeText: "", totalText: "140" }).proceed,
    ).toBe(false);
  });
});

describe("dialogAmountMatches(確認ダイアログ本文の最終照合)", () => {
  it("本文の金額が一致すれば ok", () => {
    expect(
      dialogAmountMatches("請求金額は140円です。よろしいですか？", 140),
    ).toEqual({ ok: true, found: 140 });
  });

  it("⚠本文の金額が違えば ok=false(押さない)", () => {
    const r = dialogAmountMatches("請求金額は280円です。", 140);
    expect(r.ok).toBe(false);
  });

  it("金額が読み取れない本文は照合をスキップして進む(文言変化で詰まない)", () => {
    expect(dialogAmountMatches("よろしいですか？", 140)).toEqual({
      ok: true,
      found: null,
    });
  });

  it("全角・カンマの本文でも読む", () => {
    expect(dialogAmountMatches("１，４００円を請求します", 1400).ok).toBe(true);
  });
});

describe("pickConfirmButtonIndex(押すボタンの選択)", () => {
  it("全角ＯＫを選ぶ(サイト既定)", () => {
    expect(pickConfirmButtonIndex(["ＯＫ", "キャンセル"])).toBe(0);
  });

  it("並び順が逆でも取り消し側は選ばない", () => {
    expect(pickConfirmButtonIndex(["キャンセル", "ＯＫ"])).toBe(1);
  });

  it("「はい/いいえ」経路にも対応する", () => {
    expect(pickConfirmButtonIndex(["はい", "いいえ"])).toBe(0);
  });

  it("⚠未知のラベルしか無ければ押さない(-1)", () => {
    expect(pickConfirmButtonIndex(["続行", "戻る"])).toBe(-1);
    expect(pickConfirmButtonIndex([])).toBe(-1);
  });

  it("⚠取り消し側のラベル一覧に OK 系が混ざっていない(取り違え防止)", () => {
    for (const c of SEIKYU_CONFIRM_CANCEL_LABELS) {
      expect(pickConfirmButtonIndex([c])).toBe(-1);
    }
  });
});
