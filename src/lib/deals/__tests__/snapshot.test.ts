import { describe, it, expect } from "vitest";
import { buildSnapshotFromProperty, readSnapshot, readBroker } from "../snapshot";
import { EMPTY_SNAPSHOT, EMPTY_BROKER } from "../schemas";

const prop = {
  propertyType: "apartment_unit", address: "東京都試験区試験町1-2-3", lotNumber: "試験町100番1", buildingNumber: "100番1の201",
  buildingName: "試験マンション", roomNo: "201", exclusiveArea: "65.40", totalFloorArea: "3000.00", landArea: "500.00",
  structureType: "RC", builtYear: 2001, builtMonth: 4, access: "試験線 試験駅 徒歩5分", layoutType: "3LDK",
  createdBy: "u1", assignedTo: null,
};

describe("物件から写しを作る", () => {
  it("区分は専有面積を、それ以外は延床面積を使う・数は数にする", () => {
    const s = buildSnapshotFromProperty(prop);
    expect(s).toEqual({
      buildingName: "試験マンション", roomNo: "201", address: "東京都試験区試験町1-2-3", lotNumber: "試験町100番1",
      buildingNumber: "100番1の201", propertyTypeLabel: "区分マンション", structure: "RC", builtYear: 2001, builtMonth: 4,
      floorArea: 65.4, landArea: 500, landRight: null, access: "試験線 試験駅 徒歩5分", layout: "3LDK",
    });
    expect(buildSnapshotFromProperty({ ...prop, propertyType: "house" }).floorArea).toBe(3000);
  });
  it("空の値は null", () => {
    const s = buildSnapshotFromProperty({ ...prop, roomNo: null, exclusiveArea: null, landArea: null, builtYear: null, builtMonth: null });
    expect([s.roomNo, s.floorArea, s.landArea, s.builtYear]).toEqual([null, null, null, null]);
  });
});

describe("保存済みの写しを読む", () => {
  it("欠けた項目・壊れた値は空で補う", () => {
    expect(readSnapshot({})).toEqual(EMPTY_SNAPSHOT);
    expect(readSnapshot({ roomNo: "301", builtMonth: 99 })).toEqual({ ...EMPTY_SNAPSHOT, roomNo: "301" });
    expect(readSnapshot(null)).toEqual(EMPTY_SNAPSHOT);
    expect(readBroker({ company: "試験不動産" })).toEqual({ ...EMPTY_BROKER, company: "試験不動産" });
  });
});

describe("物件の値が写しの範囲を外れているとき(最終レビュー I2)", () => {
  it("範囲外の値は保存する前に空にする=保存した写しは必ず読める", () => {
    const s = buildSnapshotFromProperty({ ...prop, builtYear: 45, access: "あ".repeat(600) });
    expect(s.builtYear).toBeNull();
    expect(s.access).toBeNull();
    expect(s.roomNo).toBe("201");
    expect(readSnapshot(s)).toEqual(s);
  });
});
