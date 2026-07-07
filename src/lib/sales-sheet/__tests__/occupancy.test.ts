import { describe, it, expect } from "vitest";
import {
  mapOccupancyStatusToMansionOccupancy,
  mapOccupancyStatusToLandOccupancy,
} from "../occupancy";

describe("mapOccupancyStatusToMansionOccupancy（現況→売マンション語彙の決定的写像）", () => {
  it("vacant → 空家、occupied → 居住中（MANSION_FIELDS.occupancy の選択肢語彙）", () => {
    expect(mapOccupancyStatusToMansionOccupancy("vacant")).toBe("空家");
    expect(mapOccupancyStatusToMansionOccupancy("occupied")).toBe("居住中");
  });

  it("選択肢語彙でカバーしない値は localizeOccupancy と同じ日本語ラベルへフォールバックする", () => {
    expect(mapOccupancyStatusToMansionOccupancy("unknown")).toBe("不明");
    // 既知の enum 以外の文字列はそのまま返す（localizeOccupancy の既存慣例）
    expect(mapOccupancyStatusToMansionOccupancy("何らかの表示済み文字列")).toBe(
      "何らかの表示済み文字列",
    );
  });

  it("null/undefined → undefined（空欄。他ビルダーの慣例と同じ「値なし」表現）", () => {
    expect(mapOccupancyStatusToMansionOccupancy(null)).toBeUndefined();
    expect(mapOccupancyStatusToMansionOccupancy(undefined)).toBeUndefined();
  });

  it("同じ入力に対し常に同じ値を返す（タイミング非依存＝決定的であることの直接検証）", () => {
    const a = mapOccupancyStatusToMansionOccupancy("vacant");
    const b = mapOccupancyStatusToMansionOccupancy("vacant");
    expect(a).toBe(b);
    expect(a).toBe("空家");
  });
});

describe("mapOccupancyStatusToLandOccupancy（現況→売土地語彙の決定的写像・[F2-A Task3]）", () => {
  it("vacant → 更地、occupied → 上物有（LAND_FIELDS.occupancy の選択肢語彙）", () => {
    expect(mapOccupancyStatusToLandOccupancy("vacant")).toBe("更地");
    expect(mapOccupancyStatusToLandOccupancy("occupied")).toBe("上物有");
  });

  it("上記2値以外(unknown・null・undefined)はundefined（手動選択に委ねる。マンション版と異なりlocalizeOccupancyへはフォールバックしない）", () => {
    expect(mapOccupancyStatusToLandOccupancy("unknown")).toBeUndefined();
    expect(mapOccupancyStatusToLandOccupancy(null)).toBeUndefined();
    expect(mapOccupancyStatusToLandOccupancy(undefined)).toBeUndefined();
  });

  it("旧 preview route が事前に日本語ラベル化した値（空室/入居中）も許容する（@codex P2: でないと同route経由の土地物件で現況欄が空欄化する）", () => {
    expect(mapOccupancyStatusToLandOccupancy("空室")).toBe("更地");
    expect(mapOccupancyStatusToLandOccupancy("入居中")).toBe("上物有");
  });

  it("同じ入力に対し常に同じ値を返す（タイミング非依存＝決定的であることの直接検証）", () => {
    const a = mapOccupancyStatusToLandOccupancy("vacant");
    const b = mapOccupancyStatusToLandOccupancy("vacant");
    expect(a).toBe(b);
    expect(a).toBe("更地");
  });
});
