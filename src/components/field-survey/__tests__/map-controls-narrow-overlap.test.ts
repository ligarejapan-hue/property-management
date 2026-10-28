/**
 * 現地調査マップの狭い画面での重なり(実機確認 2026-10-28・227 の残り)。
 * - 390px: 下の「🚶巡回を開始」が右下の Google のカメラ操作ボタンに重なった
 *   → 3つ並ぶ行の右端を、カメラ操作ボタンの幅(約40px+余白)だけ空ける
 * - 320px: 右上の「表示切替」が左上の「地図／航空写真」に重なった
 *   → 狭い画面では Google の切替を1つのボタン(押すと選べる形)にして幅を詰める
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mapTypeControlOptionsFor, NARROW_MAP_QUERY } from "../map-narrow-controls";

const map = readFileSync(join(process.cwd(), "src/components/field-survey/field-survey-map.tsx"), "utf8").replace(/\r\n/g, "\n");

describe("狭い画面の地図の操作ボタン", () => {
  it("狭い画面では地図／航空写真の切替を1つのボタンにする(google の DROPDOWN_MENU=2)", () => {
    expect(mapTypeControlOptionsFor(true)).toEqual({ style: 2 });
  });

  it("広い画面では Google の既定のまま(何も渡さない)", () => {
    expect(mapTypeControlOptionsFor(false)).toBeUndefined();
  });

  it("狭い画面は sm 未満(640px 未満)", () => {
    expect(NARROW_MAP_QUERY).toBe("(max-width: 639px)");
  });

  it("地図に切替の形を渡している", () => {
    expect(map).toContain("mapTypeControlOptions={mapTypeControlOptionsFor(narrowMap)}");
    expect(map).toContain("const narrowMap = useNarrowMap();");
  });

  it("320px の巡回中は「・巡回中」を出さず、左上の切替に重ならない(巡回中は左上の札で分かる)", () => {
    expect(map).toContain('表示切替{hasActiveSession ? <span className="max-[359px]:hidden">・巡回中</span> : null}');
  });

  it("3つ並ぶ行は、狭い画面で右下のカメラ操作ボタンの分を空ける", () => {
    expect(map).toContain("max-sm:left-[4.25rem] max-sm:right-[3.75rem] max-sm:translate-x-0 max-sm:flex-wrap");
    expect(map).not.toContain("max-sm:left-[4.25rem] max-sm:right-3 ");
  });
});
