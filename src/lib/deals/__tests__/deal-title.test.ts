import { describe, it, expect } from "vitest";
import { dealTitle } from "../deal-title";

const empty = { buildingName: null, roomNo: null, address: null };

describe("取引の見出し", () => {
  it("建物名+部屋番号を先に", () => {
    expect(dealTitle({ name: "2026-0001", propertySnapshot: { buildingName: "試験マンション", roomNo: "201", address: "試験区1-1" } }))
      .toBe("試験マンション 201");
  });
  it("建物名が無ければ住所", () => {
    expect(dealTitle({ name: "2026-0001", propertySnapshot: { ...empty, roomNo: "201", address: "試験区1-1" } })).toBe("試験区1-1");
  });
  it("物件が未入力なら保存済みの名前", () => {
    expect(dealTitle({ name: "今までの取引名", propertySnapshot: empty })).toBe("今までの取引名");
    expect(dealTitle({ name: "2026-0001", propertySnapshot: empty })).toBe("2026-0001");
  });
});
