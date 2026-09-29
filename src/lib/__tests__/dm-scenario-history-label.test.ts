import { describe, it, expect } from "vitest";
import { dmScenarioHistoryLabel } from "@/components/properties/dm-scenario-field-model";

const ALL = [
  { id: "s-inh", name: "相続", sortOrder: 10, autoKey: "inheritance", ready: true, active: true, deleted: false },
  { id: "s-off", name: "住み替え", sortOrder: 30, autoKey: null, ready: true, active: false, deleted: false },
  { id: "s-del", name: "古い種類", sortOrder: 40, autoKey: null, ready: true, active: false, deleted: true },
];

describe("変更履歴の「DMの種類」の値を名前で出す(設計 §3.4)", () => {
  it("null(空欄)は「自動」", () => {
    expect(dmScenarioHistoryLabel(null, ALL)).toBe("自動");
  });
  it("使う種類は名前だけ", () => {
    expect(dmScenarioHistoryLabel("s-inh", ALL)).toBe("相続");
  });
  it("使わない種類は「(使わない)」を付ける", () => {
    expect(dmScenarioHistoryLabel("s-off", ALL)).toBe("住み替え(使わない)");
  });
  it("削除された種類・知らない id は「(削除された種類)」", () => {
    expect(dmScenarioHistoryLabel("s-del", ALL)).toBe("古い種類(削除された種類)");
    expect(dmScenarioHistoryLabel("unknown", ALL)).toBe("(削除された種類)");
  });
  it("一覧を読めていない(null)ときは id を出さず「(読み込み中)」", () => {
    expect(dmScenarioHistoryLabel("s-inh", null)).toBe("(読み込み中)");
    expect(dmScenarioHistoryLabel(null, null)).toBe("自動");
  });
});
