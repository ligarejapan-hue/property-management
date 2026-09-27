import { describe, it, expect } from "vitest";
import { dmScenarioFieldView } from "@/components/properties/dm-scenario-field-model";

const OPTIONS = [
  { id: "s-inh", name: "相続", sortOrder: 10, autoKey: "inheritance" },
  { id: "s-vac", name: "空き家", sortOrder: 20, autoKey: "vacant" },
  { id: "s-x", name: "住み替え", sortOrder: 30, autoKey: null },
];

describe("物件の「DMの種類」欄の表示(設計 §3.6)", () => {
  it("物件に値があれば、その名前", () => {
    expect(dmScenarioFieldView({ dmScenarioId: "s-x", introductionRoute: "reception_csv" }, OPTIONS)).toEqual({
      label: "住み替え",
      autoLabel: "自動: 相続",
      unavailable: false,
    });
  });
  it("空欄で受付帳取込なら「自動: 相続」、現地調査なら「自動: 空き家」", () => {
    expect(dmScenarioFieldView({ dmScenarioId: null, introductionRoute: "reception_csv" }, OPTIONS).label).toBe("自動: 相続");
    expect(dmScenarioFieldView({ dmScenarioId: null, introductionRoute: "field_survey" }, OPTIONS).label).toBe("自動: 空き家");
  });
  it("空欄で自動が決まらなければ「自動(発送のときに選ぶ既定の種類)」", () => {
    const v = dmScenarioFieldView({ dmScenarioId: null, introductionRoute: null }, OPTIONS);
    expect(v.label).toBe("自動(発送のときに選ぶ既定の種類)");
    expect(v.unavailable).toBe(false);
  });
  it("自動の種類が「使わない」(選択肢に無い)なら自動は決まらない", () => {
    const opts = OPTIONS.filter((o) => o.autoKey !== "inheritance");
    expect(dmScenarioFieldView({ dmScenarioId: null, introductionRoute: "reception_csv" }, opts).label).toBe("自動(発送のときに選ぶ既定の種類)");
  });
  it("物件の値が選択肢に無い(使わない/削除)ときは unavailable:true・label は中立(指示文は含めない)", () => {
    // 最終レビュー Minor 4: label は読み取り専用の人がそのまま見る欄の文字なので、
    // 「自動に戻してください」という編集者向けの指示はここに含めない(その表示は
    // canWrite=true の側で DM_SCENARIO_UNAVAILABLE_LABEL を別途使う)。
    const v = dmScenarioFieldView({ dmScenarioId: "gone", introductionRoute: "reception_csv" }, OPTIONS);
    expect(v.unavailable).toBe(true);
    expect(v.label).toBe("(使えなくなった種類)");
  });
});
