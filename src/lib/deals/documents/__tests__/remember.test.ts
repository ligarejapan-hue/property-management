import { describe, expect, it } from "vitest";
import { z } from "zod";
import { latestSnapshots, rememberedStart, rememberedValues } from "../remember";
import { formValuesSchema } from "../forms/schema";
import type { FormDef } from "../forms/types";

const schema = z.object({ a: z.enum(["x", "y"]), b: z.string().nullable() }).strict() as z.ZodType<Record<string, unknown>>;
const defaults = { a: "x", b: null };

describe("前回の入力を初めの値にする", () => {
  it("写しの options が今の形に合えば、それを初めの値にする", () => {
    expect(rememberedValues(schema, defaults, { options: { a: "y", b: "前回" } })).toEqual({ a: "y", b: "前回" });
  });
  it("合わない・無い・壊れている写しは捨てて初めの値のまま", () => {
    for (const snap of [undefined, null, "壊れた", 1, {}, { options: null }, { options: { a: "z", b: null } }, { options: { a: "x", b: null, c: 1 } }]) {
      expect(rememberedValues(schema, defaults, snap)).toBe(defaults);
    }
  });
  it("書類の種類ごとに、最初に出てきた(=いちばん新しい版の)写しだけを使う", () => {
    const m = latestSnapshots([
      { docType: "a", inputSnapshot: { options: 2 } }, { docType: "b", inputSnapshot: { options: 9 } }, { docType: "a", inputSnapshot: { options: 1 } },
    ]);
    expect(m.get("a")).toEqual({ options: 2 });
    expect(m.get("b")).toEqual({ options: 9 });
    expect(m.size).toBe(2);
  });
});

describe("前回の入力: 書式が変わった写し・両手の取引の売主様用と買主様用(2026-10-30)", () => {
  const FORM: FormDef = {
    key: "f",
    entries: [
      { kind: "item", key: "side", label: "依頼の内容", choices: [{ value: "sale", label: "売却" }, { value: "purchase", label: "購入" }] },
      { kind: "item", key: "termsItem", label: "特約", fields: [{ key: "terms", label: "内容", max: 20 }] },
    ],
  };
  const fs = formValuesSchema(FORM) as z.ZodType<Record<string, unknown>>;
  const base = { side: "sale", terms: null };

  it("項目の表のある書類は、合わない項目だけ初めの値に戻して残りを使う(写しごと捨てない)", () => {
    expect(rememberedValues(fs, base, { options: { side: "sale", terms: "前回の特約", removed: "前の書式の欄" } }, FORM))
      .toEqual({ side: "sale", terms: "前回の特約" });
    // 項目の表が無い書類は今までどおり写しごと捨てる
    expect(rememberedValues(fs, base, { options: { side: "sale", terms: "前回の特約", removed: 1 } })).toBe(base);
  });

  it("同じ書類・同じ出し分けの欄の値の、いちばん新しい入力から始める(売主様用の入力が買主様用に混ざらない)", () => {
    const rows = [
      { docType: "f", inputSnapshot: { options: { side: "sale", terms: "売却の新しい特約" } } },
      { docType: "other", inputSnapshot: { options: { side: "purchase", terms: "別の書類" } } },
      { docType: "f", inputSnapshot: { options: { side: "purchase", terms: "購入の特約" } } },
      { docType: "f", inputSnapshot: { options: { side: "sale", terms: "売却の古い特約" } } },
    ];
    expect(rememberedStart(rows, "f", fs, base, "side", FORM)).toEqual({ side: "sale", terms: "売却の新しい特約" });
    expect(rememberedStart(rows, "f", fs, { ...base, side: "purchase" }, "side", FORM)).toEqual({ side: "purchase", terms: "購入の特約" });
    // 買主様用(購入)を出したことが無ければ、売主様用の入力は使わず初めの値
    const sellerOnly = rows.filter((r) => r.inputSnapshot.options.side === "sale");
    expect(rememberedStart(sellerOnly, "f", fs, { ...base, side: "purchase" }, "side", FORM)).toEqual({ side: "purchase", terms: null });
    // 出し分けの無い書類は、いちばん新しい入力
    expect(rememberedStart(rows, "f", fs, base, undefined, FORM)).toEqual({ side: "sale", terms: "売却の新しい特約" });
  });
});
