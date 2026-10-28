import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EQUIPMENT_HOUSE_SOURCE } from "../texts/equipment-house";
import { EQUIPMENT_UNIT_SOURCE } from "../texts/equipment-unit";

const ALL = { house: EQUIPMENT_HOUSE_SOURCE, unit: EQUIPMENT_UNIT_SOURCE };
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
/** 写した文面の指紋(設計 第2段階 §3.4)。落ちたら、全宅連の書式と見比べてから値を直す。値は生成したファイルから取って書いた。 */
const FINGERPRINTS: Record<keyof typeof ALL, string> = {
  house: "b1121179cb2190b6c356e729e7132803a8c89f6900c6427d221a3682d25b117e",
  unit: "f63cf3d014cd0fc688b0b9eccce1cb1b182902a955753cc6dd9f230f5587ed13",
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

  it("Excel の見えない記号(_x0002_ など・制御文字)が残っていない(最終レビュー)", async () => {
    const { DISCLOSURE_HOUSE_SOURCE } = await import("../texts/disclosure-house");
    const { DISCLOSURE_UNIT_SOURCE } = await import("../texts/disclosure-unit");
    for (const t of [...Object.values(ALL), DISCLOSURE_HOUSE_SOURCE, DISCLOSURE_UNIT_SOURCE]) {
      const s = JSON.stringify(t);
      expect(s).not.toMatch(/_x[0-9A-Fa-f]{4}_/);
      expect(JSON.stringify(t).replace(/\\n/g, "")).not.toMatch(/\\u00[01][0-9a-f]/);
    }
  });
});
