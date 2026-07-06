import { describe, it, expect } from "vitest";
import { mapOccupancyStatusToMansionOccupancy } from "../occupancy";

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
