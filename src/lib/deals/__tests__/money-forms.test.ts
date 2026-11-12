import { describe, it, expect } from "vitest";
import { bpToPercentText, dropTaxOverrideErrors, parseYen, percentTextToBp, taxOverrideFields, yenText } from "../money-forms";

describe("固都税の手で直す欄(@codex #712)", () => {
  it("合計額なら1つ、土地・建物ごとなら土地・建物(課税業者なら消費税も)", () => {
    expect(taxOverrideFields("total", true).map((f) => f.key)).toEqual(["settlement.propertyTax"]);
    expect(taxOverrideFields("items", false).map((f) => f.key)).toEqual(["settlement.propertyTaxLand", "settlement.propertyTaxBuilding"]);
    expect(taxOverrideFields("items", true).map((f) => f.key)).toEqual(["settlement.propertyTaxLand", "settlement.propertyTaxBuilding", "settlement.propertyTaxBuildingVat"]);
  });
  it("切り替えで外れた欄の「読めない」印だけを消す(見えなくなった欄で保存が止まり続けない)", () => {
    const all = [...taxOverrideFields("total", false), ...taxOverrideFields("items", true)].map((f) => f.label);
    const bad = [...all, "管理費等(買主→売主)"];
    // 合計額 → 土地・建物ごと: 合計額の欄だけが外れる
    expect(dropTaxOverrideErrors(bad, taxOverrideFields("total", false), taxOverrideFields("items", true)))
      .toEqual(bad.filter((l) => l !== "固都税(買主→売主)"));
  });
  it("残る欄(土地・建物)の印は消さない・課税業者を外すと消費税の欄の印だけ消す(@codex #712 2巡目)", () => {
    const bad = ["固都税・土地(買主→売主)", "建物分の消費税(買主→売主)"];
    expect(dropTaxOverrideErrors(bad, taxOverrideFields("items", true), taxOverrideFields("items", false))).toEqual(["固都税・土地(買主→売主)"]);
    expect(dropTaxOverrideErrors(bad, taxOverrideFields("items", false), taxOverrideFields("items", true))).toEqual(bad);
  });
});

describe("金額・率の入力", () => {
  it("カンマ・円・空白を無視して整数に・読めなければ null", () => {
    expect(parseYen("30,000,000円")).toBe(30_000_000);
    expect(parseYen(" 120000 ")).toBe(120_000);
    expect(parseYen("")).toBeNull();
    expect(parseYen("12.5")).toBeNull();
    expect(parseYen("-1")).toBeNull();
    expect(yenText(1_056_000)).toBe("1,056,000");
    expect(yenText(null)).toBe("");
  });
  it("率は % の文字と 1/100 % の整数を行き来する", () => {
    expect(bpToPercentText(1000)).toBe("10");
    expect(bpToPercentText(850)).toBe("8.5");
    expect(percentTextToBp("10")).toBe(1000);
    expect(percentTextToBp("8.5")).toBe(850);
    expect(percentTextToBp("8.555")).toBeNull();
    expect(percentTextToBp("x")).toBeNull();
  });
});

describe("最終レビュー I-1: 読めない金額で保存済みの値を消さない", () => {
  it("全角の数字も読む", async () => {
    const { parseYen } = await import("../money-forms");
    expect(parseYen("３０，０００，０００円")).toBe(30_000_000);
  });
  it("空でないのに読めない欄を名前で返す", async () => {
    const { invalidYenLabels } = await import("../money-forms");
    expect(invalidYenLabels([["売買価格", "3000万"], ["手付金", ""], ["測量費", "120000"]])).toEqual(["売買価格"]);
  });
});

describe("最終レビュー I-2: 上書きはそのパネルの鍵だけを差し替える", () => {
  it("ほかのパネルの鍵は保存済みの値を残す", async () => {
    const { mergeOverrides } = await import("../money-forms");
    const saved = { brokerageFee: 900_000, "settlement.propertyTax": 60_000 };
    expect(mergeOverrides(saved, { buildingPrice: 1 }, ["brokerageFee", "buildingPrice", "buildingTax"])).toEqual({ buildingPrice: 1, "settlement.propertyTax": 60_000 });
  });
});

describe("@codex: 行の金額は入力の文字のまま持ち、保存のときに読む", () => {
  it("textify/untextify: 空は0・読めない欄は名前で返す・ほかはそのまま", async () => {
    const { textify, untextify } = await import("../money-forms");
    const row = { room: "101", rent: 80000, deposit: 160000 };
    const form = textify(row, ["rent", "deposit"] as const);
    expect(form).toEqual({ room: "101", rent: "80000", deposit: "160000" });
    expect(untextify({ ...form, rent: "８００００", deposit: "" }, ["rent", "deposit"] as const, (k) => `1行目の${k}`)).toEqual({
      value: { room: "101", rent: 80000, deposit: 0 }, bad: [],
    });
    expect(untextify({ ...form, rent: "8万" }, ["rent", "deposit"] as const, (k) => `1行目の${k}`).bad).toEqual(["1行目のrent"]);
  });
});

describe("@codex 2巡目: 手で直す欄の打ち間違いで上書きを消さない", () => {
  it("空=消す・読める=その値・読めない=そのまま(消さない)", async () => {
    const { overrideInput } = await import("../money-forms");
    expect(overrideInput("")).toEqual({ kind: "clear" });
    expect(overrideInput("９０００００")).toEqual({ kind: "set", value: 900_000 });
    expect(overrideInput("90万")).toEqual({ kind: "invalid" });
  });
});
