/**
 * 地番/家屋番号の「読める形か」の判定（設計 §4.3）。
 *
 * ⚠受理する範囲は normalizeChibanForDialog が扱える表記に合わせる。
 *   狭めると、既に保存されている物件や取込済みのCSVが新しい検査で落ちる
 *   （今まで取れていたものが取れなくなる）。
 */
import { describe, it, expect } from "vitest";
import { isReadableChiban } from "@/lib/registry-fetch/chiban-input";

describe("受理する（既存データを落とさない）", () => {
  it.each([
    ["数字だけ", "69"],
    ["ハイフン区切り", "69-2"],
    ["3段", "1-1-1"],
    ["番地", "1番地2"],
    ["番", "69番2"],
    ["の", "69の2"],
    ["ノ", "1ノ2"],
    ["ダッシュ", "69‐2"],
    ["長音記号", "69ー2"],
    ["全角ハイフン", "69－2"],
    ["全角数字", "６９－２"],
    ["前後の空白", "  69-2  "],
    ["番のみで終わる", "5番"],
    ["番と の の混在", "1番2の3"],
  ])("%s: %s", (_label, raw) => {
    expect(isReadableChiban(raw)).toBe(true);
  });
});

describe("⚠拒否する（通すと別の筆を買う）", () => {
  it.each([
    ["英字が混じる", "abc1x2"],
    ["未対応の文字が数字と同居", "1x2"],
    ["説明文がくっついている", "69-2 の隣"],
    ["号は区切りとして扱わない", "1号2"],
    ["数字が無い", "あ番"],
    ["空", ""],
    ["空白のみ", "   "],
    ["記号だけ", "-"],
  ])("%s: %s", (_label, raw) => {
    expect(isReadableChiban(raw)).toBe(false);
  });

  it("null / undefined も false", () => {
    expect(isReadableChiban(null)).toBe(false);
    expect(isReadableChiban(undefined)).toBe(false);
  });
});

describe("繰り返し呼んでも結果が変わらない（正規表現の状態を持ち越さない）", () => {
  it("同じ値を10回判定しても同じ答え", () => {
    // ⚠共有する正規表現に g フラグが付いていると lastIndex を持ち越して
    //   2回目以降の判定が狂う。replace 以外で使っていないことの回帰確認。
    for (let i = 0; i < 10; i += 1) {
      expect(isReadableChiban("６９－２")).toBe(true);
      expect(isReadableChiban("abc1x2")).toBe(false);
    }
  });
});
