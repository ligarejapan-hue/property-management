import { describe, expect, it } from "vitest";
import { z } from "zod";
import { latestSnapshots, rememberedValues } from "../remember";

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
