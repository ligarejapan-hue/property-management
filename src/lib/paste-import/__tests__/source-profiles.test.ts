import { describe, it, expect } from "vitest";
import {
  detectSourceProfile,
  splitBuildingAndRoom,
  SOURCE_PROFILE_LABELS,
} from "../source-profiles";

describe("detectSourceProfile（送り元の見分け）", () => {
  it("査定ナンバーがあれば HOME4U 査定依頼", () => {
    expect(detectSourceProfile(["査定ナンバー", "お名前"])).toBe("home4u_assessment");
  });
  it("空き家所有者との関係性があれば HOME4U 空き家相談", () => {
    expect(detectSourceProfile(["空き家所有者との関係性", "物件所在地"]))
      .toBe("home4u_vacant_house");
  });
  it("どちらでもなければ generic", () => {
    expect(detectSourceProfile(["所在地", "価格"])).toBe("generic");
    expect(detectSourceProfile([])).toBe("generic");
  });
  it("すべてのプロファイルに日本語の名前がある（確認画面に出すため）", () => {
    for (const id of ["home4u_assessment", "home4u_vacant_house", "generic"] as const) {
      expect(SOURCE_PROFILE_LABELS[id]).toBeTruthy();
    }
  });
});

describe("splitBuildingAndRoom（建物名と部屋番号を切り出す）", () => {
  it("実サンプルBの所在地から部屋番号303を切り出す", () => {
    const r = splitBuildingAndRoom(
      "東京都世田谷区等々力2丁目15番12号リーフィアレジデンス等々力303",
      "リーフィアレジデンス等々力",
    );
    expect(r.address).toBe("東京都世田谷区等々力2丁目15番12号");
    expect(r.roomNo).toBe("303");
  });

  it("「303号室」のように号室が付いていても切り出す", () => {
    const r = splitBuildingAndRoom("東京都A区B1-2-3グリーンコート303号室", "グリーンコート");
    expect(r.address).toBe("東京都A区B1-2-3");
    expect(r.roomNo).toBe("303");
  });

  it("建物名の後ろに何も無ければ部屋番号は null（住所からは建物名を外す）", () => {
    const r = splitBuildingAndRoom("東京都A区B1-2-3グリーンコート", "グリーンコート");
    expect(r.address).toBe("東京都A区B1-2-3");
    expect(r.roomNo).toBeNull();
  });

  it("⚠建物名が無ければ何も切り出さない（推測しない）", () => {
    const r = splitBuildingAndRoom("東京都A区B1-2-3グリーンコート303", null);
    expect(r.address).toBe("東京都A区B1-2-3グリーンコート303");
    expect(r.roomNo).toBeNull();
  });

  it("⚠建物名が住所に含まれていなければ何も切り出さない", () => {
    const r = splitBuildingAndRoom("東京都A区B1-2-3", "グリーンコート");
    expect(r.address).toBe("東京都A区B1-2-3");
    expect(r.roomNo).toBeNull();
  });

  it("部屋番号らしくない文字列は部屋番号にしない", () => {
    const r = splitBuildingAndRoom("東京都A区B1-2-3グリーンコートの南側", "グリーンコート");
    expect(r.roomNo).toBeNull();
  });
});
