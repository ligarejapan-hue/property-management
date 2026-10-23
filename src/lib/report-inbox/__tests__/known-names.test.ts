import { describe, it, expect } from "vitest";
import { findKnownBuildingName } from "../known-names";

const NAMES = ["ハマイハイライズ", "西荻リリエンハイム", "東急ドエル", "東急ドエル世田谷", "ラポール上野毛", "AB"];

describe("findKnownBuildingName", () => {
  it("本文に出ている登録済みの物件名と、その直後の部屋番号を返す", () => {
    const text = "不動産売買契約書\n\n物件の表示\n名称 ハマイハイライズ 305号室\n所在 …";
    expect(findKnownBuildingName(text, NAMES)).toEqual({ buildingName: "ハマイハイライズ", roomNo: "305" });
  });

  it("全角・空白の違いを吸収し、返す名前は DB の表記のまま", () => {
    const text = "物件名：ハマイ ハイライズ　３０５号";
    expect(findKnownBuildingName(text, NAMES)).toEqual({ buildingName: "ハマイハイライズ", roomNo: "305" });
  });

  it("複数あれば最も前に出た名前。同じ位置なら長い名前", () => {
    expect(findKnownBuildingName("西荻リリエンハイム 407 … ハマイハイライズ", NAMES)?.buildingName).toBe("西荻リリエンハイム");
    expect(findKnownBuildingName("東急ドエル世田谷 1203号室", NAMES)).toEqual({ buildingName: "東急ドエル世田谷", roomNo: "1203" });
  });

  it("部屋番号が直後に無ければ null", () => {
    expect(findKnownBuildingName("ラポール上野毛の管理規約", NAMES)).toEqual({ buildingName: "ラポール上野毛", roomNo: null });
  });

  it("短すぎる名前(2文字以下)は探さない・無ければ null・空でも落ちない", () => {
    expect(findKnownBuildingName("AB 101号", NAMES)).toBeNull();
    expect(findKnownBuildingName("該当なし", NAMES)).toBeNull();
    expect(findKnownBuildingName("", NAMES)).toBeNull();
    expect(findKnownBuildingName(null, NAMES)).toBeNull();
    expect(findKnownBuildingName("ハマイハイライズ", [])).toBeNull();
  });

  it("先頭 3,000 文字の外は見ない", () => {
    expect(findKnownBuildingName(`${"x".repeat(3000)}ハマイハイライズ`, NAMES)).toBeNull();
  });
});
