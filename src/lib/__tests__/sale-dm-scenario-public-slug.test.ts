import { describe, it, expect } from "vitest";
import { saleDmScenarioPatchSchema } from "@/lib/validators-sale-dm";

describe("saleDmScenarioPatchSchema.publicSlug(広告用の公開ページの公開名)", () => {
  it("小文字英数字とハイフン 2〜40 字を通し、大文字は小文字に揃える", () => {
    expect(saleDmScenarioPatchSchema.parse({ publicSlug: " Souzoku-Mansion " }).publicSlug).toBe("souzoku-mansion");
  });
  it("空文字と null は null(=公開しない)。未指定は触らない(undefined)", () => {
    expect(saleDmScenarioPatchSchema.parse({ publicSlug: "" }).publicSlug).toBeNull();
    expect(saleDmScenarioPatchSchema.parse({ publicSlug: null }).publicSlug).toBeNull();
    expect("publicSlug" in saleDmScenarioPatchSchema.parse({ name: "相続" })).toBe(false);
  });
  it("規則外は拒否(全角・1字・記号・スラッシュ・41字)", () => {
    for (const bad of ["相続", "a", "sou_zoku", "sou/zoku", "a".repeat(41), "sou zoku"]) {
      expect(saleDmScenarioPatchSchema.safeParse({ publicSlug: bad }).success, bad).toBe(false);
    }
  });
});
