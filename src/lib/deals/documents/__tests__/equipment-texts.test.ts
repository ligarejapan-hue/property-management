import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EQUIPMENT_HOUSE_SOURCE } from "../texts/equipment-house";
import { EQUIPMENT_UNIT_SOURCE } from "../texts/equipment-unit";

const ALL = { house: EQUIPMENT_HOUSE_SOURCE, unit: EQUIPMENT_UNIT_SOURCE };
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
/** 写した文面の指紋(設計 第2段階 §3.4)。落ちたら、全宅連の書式と見比べてから値を直す。値は生成したファイルから取って書いた。 */
const FINGERPRINTS: Record<keyof typeof ALL, string> = {
  house: "62f1154e8867834cf6046208d56914a0faaf08a2eeb1a1643b4ffc780442ea8d",
  unit: "1bbb19fcfebce95967bbd6239f19acb59dd1c9c9beb6e30de0072aaa2fe2ee37",
};

describe("全宅連の付帯設備表から写した文面", () => {
  it("どこから写したか・指紋", () => {
    for (const t of Object.values(ALL)) {
      expect(t.source).toMatch(/^futaisetubi_/);
      expect(t.modified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const fp = (t: (typeof ALL)[keyof typeof ALL]) => hash({ cover: [t.coverTitle, ...t.cover], guide: [t.guideTitle, t.guide], form: t.formCells });
    expect({ house: fp(ALL.house), unit: fp(ALL.unit) }).toEqual(FINGERPRINTS);
  });
  it("表紙・頭の説明文・注２の説明", () => {
    expect(EQUIPMENT_HOUSE_SOURCE.coverTitle).toBe("『付帯設備表』（土地建物用）のご記入にあたって");
    for (const t of Object.values(ALL)) {
      expect(t.formCells.some((c) => c.startsWith("「設備の有無」欄に「有」とした付帯設備等は"))).toBe(true);
      expect(t.formCells.some((c) => c.startsWith("※注２の表示が「有」の設備は"))).toBe(true);
    }
  });
  it("前の会社の名前・リースバックの語が無い", () => {
    for (const t of Object.values(ALL)) for (const w of ["インテリックス", "リースバック"]) expect(JSON.stringify(t)).not.toContain(w);
  });
});
