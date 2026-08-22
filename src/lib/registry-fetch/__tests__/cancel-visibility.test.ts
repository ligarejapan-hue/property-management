/**
 * 「中止」ボタンを出してよいかの判定 (純関数)。
 *
 * 発注者指示 (2026-08-21):「確定ボタンを押すまでは中止ボタンを出してください。」
 *
 * ⚠従来、有料取得は**受け付けた直後にサーバーが中止の受付口を閉じて**いた
 *   (課金だけ残る事故を避けるための安全策)。その結果、候補が1件のとき
 *   自動で取得へ進む今の流れでは**押せる時間が数秒**しか無かった。
 *
 * ⚠**画面が文字から推測してはいけない**。実況の文言を読んで「まだ課金前らしい」と
 *   判断すると、文言を1つ変えただけで**課金中に中止ボタンが出る**(押しても効かない
 *   のに押せる=嘘の表示)。可否は**サーバーが持つ受付口の状態**だけで決める。
 */
import { describe, it, expect } from "vitest";
import {
  shouldShowCancelButton,
  cancelClosedNotice,
} from "../cancel-visibility";

describe("shouldShowCancelButton", () => {
  it("受付口が開いていて、まだ終わっていなければ出す", () => {
    expect(
      shouldShowCancelButton({
        cancelWindowOpen: true,
        done: false,
        cancelRequested: false,
      }),
    ).toBe(true);
  });

  it("受付口が閉じたら出さない(課金の直前で閉じる)", () => {
    expect(
      shouldShowCancelButton({
        cancelWindowOpen: false,
        done: false,
        cancelRequested: false,
      }),
    ).toBe(false);
  });

  it("終わっていたら出さない", () => {
    expect(
      shouldShowCancelButton({
        cancelWindowOpen: true,
        done: true,
        cancelRequested: false,
      }),
    ).toBe(false);
  });

  it("もう押した後は出さない(二重に押させない)", () => {
    expect(
      shouldShowCancelButton({
        cancelWindowOpen: true,
        done: false,
        cancelRequested: true,
      }),
    ).toBe(false);
  });

  it("⚠まだ分からないとき(null)は出さない = 安全側", () => {
    // 効かない中止ボタンを出すのは「押したのに止まらない」を生む。
    // 出し損ねるのは機会損失で済む。**分からないなら出さない**。
    expect(
      shouldShowCancelButton({
        cancelWindowOpen: null,
        done: false,
        cancelRequested: false,
      }),
    ).toBe(false);
  });

  it("総当たり: 出すのは『開いている × 未完了 × 未押下』の1通りだけ", () => {
    const values: Array<boolean | null> = [true, false, null];
    const shown: string[] = [];
    for (const cancelWindowOpen of values) {
      for (const done of [true, false]) {
        for (const cancelRequested of [true, false]) {
          if (
            shouldShowCancelButton({ cancelWindowOpen, done, cancelRequested })
          ) {
            shown.push(`${String(cancelWindowOpen)}/${done}/${cancelRequested}`);
          }
        }
      }
    }
    expect(shown).toEqual(["true/false/false"]);
  });
});

describe("cancelClosedNotice", () => {
  it("受付口が閉じて、まだ終わっていないときだけ知らせる", () => {
    expect(
      cancelClosedNotice({
        cancelWindowOpen: false,
        done: false,
        started: true,
      }),
    ).not.toBeNull();
  });

  it("⚠黙って消さない(消えた理由が分からないと『壊れた』と思われる)", () => {
    const notice = cancelClosedNotice({
      cancelWindowOpen: false,
      done: false,
      started: true,
    });
    expect(notice).toContain("中止できません");
  });

  it("終わっていたら知らせない(結果を見る場面で警告を残さない)", () => {
    expect(
      cancelClosedNotice({ cancelWindowOpen: false, done: true, started: true }),
    ).toBeNull();
  });

  it("まだ始まっていない/開いているときは知らせない", () => {
    expect(
      cancelClosedNotice({
        cancelWindowOpen: true,
        done: false,
        started: true,
      }),
    ).toBeNull();
    expect(
      cancelClosedNotice({
        cancelWindowOpen: false,
        done: false,
        started: false,
      }),
    ).toBeNull();
  });

  it("まだ分からないとき(null)は知らせない(閉じたと決めつけない)", () => {
    expect(
      cancelClosedNotice({ cancelWindowOpen: null, done: false, started: true }),
    ).toBeNull();
  });
});
