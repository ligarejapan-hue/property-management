import { describe, expect, it } from "vitest";
import { propertySideRows } from "../property-side";

const map = (rows: { label: string; value: string }[]) => Object.fromEntries(rows.map((r) => [r.label, r.value]));

describe("propertySideRows", () => {
  it("値を画面の言葉と単位で出す", () => {
    const rows = map(propertySideRows({
      caseStatus: "contract_planned", propertyType: "unit", buildingName: "確認マンション", roomNo: "201",
      address: "東京都確認区1-2-3", salePrice: 3000, exclusiveArea: 50.5, exclusiveAreaRegistry: 48,
      builtYear: 2001, builtMonth: 4, occupancyStatus: "vacant", managementFee: 12000,
      assignee: { name: "担当 太郎" },
    }));
    expect(rows["案件ステータス"]).toBe("契約予定");
    expect(rows["物件名"]).toBe("確認マンション");
    expect(rows["価格"]).toBe("3,000万円");
    expect(rows["専有面積(壁芯)"]).toBe("50.5㎡");
    expect(rows["専有面積(登記簿)"]).toBe("48㎡");
    expect(rows["築年月"]).toBe("2001年4月");
    expect(rows["現況"]).toBe("空室");
    expect(rows["管理費"]).toBe("12,000円/月");
    expect(rows["担当者"]).toBe("担当 太郎");
  });

  it("値が無い行は出さず、案件ステータスは出す", () => {
    const rows = propertySideRows({ caseStatus: "hold", address: "", note: null, buildingName: "" });
    expect(rows).toEqual([{ label: "案件ステータス", value: "保留" }]);
  });

  it("契約・決済の日付の見出しは、物件の画面と同じく案件ステータスで変わる(2026-11-15)", () => {
    const dates = { contractPlannedOn: "2026-11-20", settlementPlannedOn: "2026-12-20" };
    const labels = (caseStatus: string) => propertySideRows({ caseStatus, ...dates }).filter((r) => r.value.startsWith("2026-")).map((r) => r.label);
    expect(labels("contract_planned")).toEqual(["契約予定日", "決済予定日"]);
    expect(labels("contracted")).toEqual(["契約日", "決済予定日"]);
    expect(labels("sold")).toEqual(["契約日", "決済日"]);
    expect(labels("hold")).toEqual(["契約予定日", "決済予定日"]);
    // 値と並びは変わらない(案件ステータスのすぐ下)
    expect(propertySideRows({ caseStatus: "sold", ...dates }).slice(0, 3)).toEqual([
      { label: "案件ステータス", value: "決済完了" }, { label: "契約日", value: "2026-11-20" }, { label: "決済日", value: "2026-12-20" },
    ]);
  });

  it("築年だけなら年だけ、0円や0階も出す", () => {
    const rows = map(propertySideRows({ caseStatus: "hold", builtYear: 1999, managementFee: 0, floorNo: 0 }));
    expect(rows["築年月"]).toBe("1999年");
    expect(rows["管理費"]).toBe("0円/月");
    expect(rows["所在階"]).toBe("0階");
  });

  it("棟につながる部屋の構造・築年月は棟の値を出す", () => {
    const rows = map(propertySideRows({
      caseStatus: "hold", structureType: "古い構造", builtYear: 1980, builtMonth: 1,
      building: { structureType: "RC", builtYear: 2001, builtMonth: 4 },
    }));
    expect(rows["構造"]).toBe("RC");
    expect(rows["築年月"]).toBe("2001年4月");
    const empty = map(propertySideRows({ caseStatus: "hold", structureType: "古い構造", builtYear: 1980, building: {} }));
    expect(empty["構造"]).toBeUndefined();
    expect(empty["築年月"]).toBeUndefined();
  });

  it("知らない選択肢は値をそのまま出す", () => {
    expect(map(propertySideRows({ caseStatus: "hold", occupancyStatus: "xyz" }))["現況"]).toBe("xyz");
  });
});
