import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DISCLOSURE_HOUSE_SOURCE } from "../texts/disclosure-house";
import { DISCLOSURE_UNIT_SOURCE } from "../texts/disclosure-unit";

const ALL = { house: DISCLOSURE_HOUSE_SOURCE, unit: DISCLOSURE_UNIT_SOURCE };
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
/** 写した文面の指紋(設計 第2段階 §3.4)。落ちたら、全宅連の書式と見比べてから値を直す。値は生成したファイルから取って書いた。 */
const FINGERPRINTS: Record<keyof typeof ALL, string> = {
  house: "ee27e58182affaf5b6ded97e43b50fc17e5015c2a97658e19850d2973c148b96",
  unit: "a084d1cd0334859a9e11fc42a9753ed7cf8911225876f81deb8a85c9c8c6d2d5",
};

describe("全宅連の物件状況確認書(告知書)から写した文面", () => {
  it("どこから写したか・指紋", () => {
    for (const t of Object.values(ALL)) {
      expect(t.source).toMatch(/^kokuchisyo_/);
      expect(t.modified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const fp = (t: (typeof ALL)[keyof typeof ALL]) => hash({ cover: [t.coverTitle, ...t.cover], guide: [t.guideTitle, t.guide], form: t.formCells });
    expect({ house: fp(ALL.house), unit: fp(ALL.unit) }).toEqual(FINGERPRINTS);
  });
  it("表紙・ご記入にあたって・告知書の頁の要の文", () => {
    expect(DISCLOSURE_HOUSE_SOURCE.coverTitle).toBe("『物件状況確認書（告知書／土地建物・土地用）』のご記入にあたって");
    expect(DISCLOSURE_UNIT_SOURCE.formCells[0]).toBe("物件状況確認書（告知書／区分所有建物用）");
    for (const t of Object.values(ALL)) {
      expect(t.formCells).toContain("売主は、売主が現在知っている売買物件の状況について、以下のとおり買主に説明いたします。");
      expect(t.guide.some((b) => b.kind === "note" && b.text.includes("宅地建物取引業者による人の死の告知に関するガイドライン"))).toBe(true);
      expect(t.guide.find((b) => b.kind === "row")).toMatchObject({ item: "①雨漏り" });
    }
  });
  it("前の会社の名前・リースバックの語が無い", () => {
    for (const t of Object.values(ALL)) for (const w of ["インテリックス", "リースバック"]) expect(JSON.stringify(t)).not.toContain(w);
  });
});
