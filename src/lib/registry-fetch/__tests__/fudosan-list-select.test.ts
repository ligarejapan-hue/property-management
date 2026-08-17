/**
 * 請求リスト(fudosan-list)の行選択の挙動テスト。
 *
 * probe13(2026-08-17)実測: 確定(fuBtnForward)の着地はマイページでなく請求リスト。
 * check した行がそのまま請求対象になる=お金の一歩手前なので、
 * 「迷ったら選ばない」「同一内容の重複だけ先頭を選ぶ」を挙動で固定する。
 */
import { describe, expect, it } from "vitest";

import {
  FUDOSAN_LIST_CHECKBOX_NAME,
  FUDOSAN_LIST_HIDDEN_PREFIX,
  normalizeKuikiForCompare,
  selectFudosanListRow,
  type FudosanListRow,
} from "@/lib/registry-fetch/fudosan-list-select";

const KUIKI = "神奈川県横浜市南区井土ケ谷中町";

function row(over: Partial<FudosanListRow> & { index: number }): FudosanListRow {
  return {
    chiban: "６９－２", // サイトは全角(probe13 実測)
    kuiki: KUIKI,
    seikyuType: "所有者事項",
    seikyuzumi: "false",
    checked: false,
    ...over,
  };
}

const EXPECTED = {
  targetKey: "69-2", // normalizeChibanForDialog 済みの形
  kuiki: KUIKI,
  seikyuTypeLabel: "所有者事項",
};

describe("selectFudosanListRow", () => {
  it("全角地番・完全一致の1行を選ぶ(サイトの全角と targetKey の半角を突き合わせる)", () => {
    expect(selectFudosanListRow([row({ index: 1 })], EXPECTED)).toEqual({
      ok: true,
      index: 1,
      duplicateCount: 0,
    });
  });

  it("⚠同一内容の重複(過去テストの未請求の残り)は index 最小の1件を選び、残数を報告する", () => {
    const pick = selectFudosanListRow(
      [row({ index: 3 }), row({ index: 1 }), row({ index: 2 })],
      EXPECTED,
    );
    expect(pick).toEqual({ ok: true, index: 1, duplicateCount: 2 });
  });

  it("⚠地番が同じでも所在(kuiki)が違う行は選ばない(別の筆)", () => {
    const pick = selectFudosanListRow(
      [row({ index: 1, kuiki: "神奈川県横浜市南区別の町" })],
      EXPECTED,
    );
    expect(pick).toEqual({ ok: false, reason: "no-match" });
  });

  it("⚠請求済み(seikyuzumi!=false)の行は選ばない(二重課金の入口)", () => {
    const pick = selectFudosanListRow(
      [row({ index: 1, seikyuzumi: "true" })],
      EXPECTED,
    );
    expect(pick).toEqual({ ok: false, reason: "no-match" });
  });

  it("⚠種別違い(全部事項の行など)は選ばない", () => {
    const pick = selectFudosanListRow(
      [row({ index: 1, seikyuType: "全部事項" })],
      EXPECTED,
    );
    expect(pick).toEqual({ ok: false, reason: "no-match" });
  });

  it("所在の全角/空白の揺れは吸収する(NFKC+空白除去)", () => {
    const pick = selectFudosanListRow(
      [row({ index: 1, kuiki: "神奈川県 横浜市南区　井土ケ谷中町" })],
      EXPECTED,
    );
    expect(pick).toEqual({ ok: true, index: 1, duplicateCount: 0 });
    expect(normalizeKuikiForCompare("Ａ Ｂ　Ｃ")).toBe("ABC");
  });

  it("⚠所在が取れていない(空)なら選ばない(kuiki-empty)", () => {
    expect(
      selectFudosanListRow([row({ index: 1 })], { ...EXPECTED, kuiki: "  " }),
    ).toEqual({ ok: false, reason: "kuiki-empty" });
  });

  it("行ゼロは no-rows(確定したのに行が無い=画面想定違い)", () => {
    expect(selectFudosanListRow([], EXPECTED)).toEqual({
      ok: false,
      reason: "no-rows",
    });
  });

  it("hidden 接頭辞と checkbox 名は probe13 の実測値", () => {
    expect(FUDOSAN_LIST_HIDDEN_PREFIX).toEqual({
      chiban: "chiban_",
      kuiki: "chibanKuiki_",
      seikyuType: "seikyuType_",
      seikyuzumi: "seikyuzumi_",
      ryokin: "ryokin_",
    });
    expect(FUDOSAN_LIST_CHECKBOX_NAME).toBe("sentaku");
  });
});
