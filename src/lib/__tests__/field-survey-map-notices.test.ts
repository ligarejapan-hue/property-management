/**
 * 地図の上に直接出す通知文の純関数 (地図操作性 第1弾 A3/A4・発注者承認 2026-08-24)。
 *
 * 背景(実測):
 * - ピン100/物件200件の打ち切りは API が hasNext を返しているのに画面が捨てて
 *   いて、**無言で古いピンが消えていた**(二度歩き防止の穴)。
 * - 踏破の「確認中/取得失敗/範囲広すぎ」の断りが**スマホでは閉じたパネルの中**
 *   にしかなく、「色がない=誰も通っていない」と誤読させる状態だった。
 * どちらも「何を出すか」を純関数に出し、表示の場所(地図上のチップ)と分離する。
 */
import { describe, it, expect } from "vitest";
import {
  truncationNotice,
  coverageOnMapNotice,
} from "../field-survey-map-notices";

describe("truncationNotice(打ち切りの断り)", () => {
  it("どちらも打ち切りなし → null", () => {
    expect(
      truncationNotice({ pinsTruncated: false, propertiesTruncated: false }),
    ).toBeNull();
  });

  it("ピンだけ打ち切り → ピンの断り", () => {
    expect(
      truncationNotice({ pinsTruncated: true, propertiesTruncated: false }),
    ).toBe("表示しきれていないピンがあります。地図を拡大してください。");
  });

  it("物件だけ打ち切り → 物件の断り", () => {
    expect(
      truncationNotice({ pinsTruncated: false, propertiesTruncated: true }),
    ).toBe("表示しきれていない物件があります。地図を拡大してください。");
  });

  it("両方打ち切り → 両方まとめた断り", () => {
    expect(
      truncationNotice({ pinsTruncated: true, propertiesTruncated: true }),
    ).toBe(
      "表示しきれていないピン・物件があります。地図を拡大してください。",
    );
  });
});

describe("coverageOnMapNotice(踏破の状態を地図上へ)", () => {
  const CASES: Array<{
    coverage: string;
    tracks: string;
    expected: string | null;
  }> = [];
  // 総当たり: 5状態 × 5状態。優先度は unavailable > too-wide > loading > (ready/off=null)。
  const STATUSES = ["off", "loading", "ready", "too-wide", "unavailable"] as const;
  const rank = (s: string) =>
    s === "unavailable" ? 3 : s === "too-wide" ? 2 : s === "loading" ? 1 : 0;
  const TEXT: Record<number, string | null> = {
    3: "歩いた場所を取得できませんでした。色が付いていない場所も、通っている可能性があります。",
    2: "範囲が広すぎるため、歩いた場所は表示していません。",
    1: "歩いた場所を確認中…",
    0: null,
  };
  for (const coverage of STATUSES) {
    for (const tracks of STATUSES) {
      CASES.push({
        coverage,
        tracks,
        expected: TEXT[Math.max(rank(coverage), rank(tracks))],
      });
    }
  }

  it.each(CASES)("coverage=$coverage tracks=$tracks", ({ coverage, tracks, expected }) => {
    expect(
      coverageOnMapNotice({
        coverage: coverage as never,
        tracks: tracks as never,
      }),
    ).toBe(expected);
  });

  it("片方だけレイヤOFF(off)でも、もう片方の失敗は必ず出す", () => {
    expect(
      coverageOnMapNotice({ coverage: "off", tracks: "unavailable" }),
    ).toContain("取得できませんでした");
  });
});
