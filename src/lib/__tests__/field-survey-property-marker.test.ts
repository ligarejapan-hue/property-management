/**
 * 物件マーカーの見た目(第3弾)。
 *
 * 従来は全部が Google 既定の赤バルーンで、種別も状況も見分けられなかった。
 * ⚠**赤は「物件」を意味する既存の合図**(ピン側は物件と混同しないよう意図的に
 *   赤を避けている: field-survey-pin-marker.ts のパレット注記)。したがって
 *   物件を多色化して見分けさせるのは誤り。赤のまま**種別を1文字**で示し、
 *   終わった案件だけ灰色にする(ピンの「対応済み=灰」と同じ語彙)。
 */
import { describe, it, expect } from "vitest";
import {
  propertyMarkerStyle,
  PROPERTY_TYPE_GLYPHS,
  PROPERTY_DONE_GLYPH,
  isPropertyCaseDone,
} from "@/lib/field-survey-property-marker";
import { PROPERTY_TYPE_OPTIONS } from "@/lib/property-types";
import { pinMarkerStyle } from "@/lib/field-survey-pin-marker";
import { FIELD_SURVEY_PIN_TYPES } from "@/lib/field-survey-constants";

describe("propertyMarkerStyle", () => {
  it("既定は赤系(物件であることの合図を保つ)", () => {
    const s = propertyMarkerStyle({ propertyType: "house", caseStatus: "new_case" });
    expect(s.background.toUpperCase()).toMatch(/^#[0-9A-F]{6}$/);
    // 赤 = R が G,B より十分大きい
    const r = parseInt(s.background.slice(1, 3), 16);
    const g = parseInt(s.background.slice(3, 5), 16);
    const b = parseInt(s.background.slice(5, 7), 16);
    expect(r).toBeGreaterThan(g + 40);
    expect(r).toBeGreaterThan(b + 40);
  });

  it("種別ごとに1文字の印が付く(土地=土・戸建=戸 など)", () => {
    expect(propertyMarkerStyle({ propertyType: "land", caseStatus: "new_case" }).glyph).toBe("土");
    expect(propertyMarkerStyle({ propertyType: "house", caseStatus: "new_case" }).glyph).toBe("戸");
    expect(
      propertyMarkerStyle({ propertyType: "apartment_unit", caseStatus: "new_case" }).glyph,
    ).toBe("区");
  });

  it("終わった案件(売却済み・終了)は灰色+済みの印(ピンの対応済みと同じ語彙)", () => {
    for (const cs of ["sold", "closed"]) {
      const s = propertyMarkerStyle({ propertyType: "house", caseStatus: cs });
      expect(s.glyph).toBe(PROPERTY_DONE_GLYPH);
      const r = parseInt(s.background.slice(1, 3), 16);
      const g = parseInt(s.background.slice(3, 5), 16);
      const b = parseInt(s.background.slice(5, 7), 16);
      // 灰 = RGB がほぼ揃っている
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(30);
    }
  });

  it("知らない種別・欠けた値でも例外にせず既定の見た目に倒す(地図を壊さない)", () => {
    for (const t of [null, undefined, "", "no_such_type", "  "]) {
      const s = propertyMarkerStyle({ propertyType: t, caseStatus: null });
      expect(s.glyph.length).toBeGreaterThan(0);
      expect(s.background).toMatch(/^#[0-9A-F]{6}$/i);
      expect(s.borderColor).toMatch(/^#[0-9A-F]{6}$/i);
      expect(s.glyphColor).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });

  it("現役の種別すべてに印が定義されている(旧値を除く)", () => {
    const legacy = new Set(["building", "unit"]);
    for (const o of PROPERTY_TYPE_OPTIONS) {
      if (legacy.has(o.value)) continue;
      expect(PROPERTY_TYPE_GLYPHS[o.value], o.value).toBeTruthy();
      expect(PROPERTY_TYPE_GLYPHS[o.value].length, o.value).toBe(1);
    }
  });

  it("印は白抜き(赤・灰のどちらの地でも読める)", () => {
    const a = propertyMarkerStyle({ propertyType: "house", caseStatus: "new_case" });
    const b = propertyMarkerStyle({ propertyType: "house", caseStatus: "sold" });
    expect(a.glyphColor.toUpperCase()).toBe("#FFFFFF");
    expect(b.glyphColor.toUpperCase()).toBe("#FFFFFF");
  });

  it("⚠物件の色は調査ピンのどの色とも被らない(一目で見分けられる)", () => {
    // これが「赤=物件」を保つ根拠。ピン側のパレットは物件と混同しないよう
    // 意図的に赤を避けている(field-survey-pin-marker.ts のコメント)。どちらかの
    // 色を足すときは、この判定が衝突を教える。
    const propertyBackgrounds = new Set<string>();
    for (const t of PROPERTY_TYPE_OPTIONS.map((o) => o.value)) {
      for (const cs of ["new_case", "negotiating", "sold", "closed", null]) {
        propertyBackgrounds.add(
          propertyMarkerStyle({ propertyType: t, caseStatus: cs }).background.toUpperCase(),
        );
      }
    }
    const pinBackgrounds = new Set<string>();
    for (const t of [...FIELD_SURVEY_PIN_TYPES, "unknown_type"]) {
      for (const st of ["open", "closed"]) {
        pinBackgrounds.add(
          pinMarkerStyle({ pinType: t, status: st, isOwn: true }).background.toUpperCase(),
        );
      }
    }
    // 「終わったもの=灰」は両方が共有する語彙なので、灰は衝突から除く。
    const GREY = propertyMarkerStyle({
      propertyType: "house",
      caseStatus: "sold",
    }).background.toUpperCase();
    for (const bg of propertyBackgrounds) {
      if (bg === GREY) continue;
      expect(pinBackgrounds.has(bg), `物件色 ${bg} がピン色と衝突`).toBe(false);
    }
  });

  it("済み判定は関数として公開する(まとめ表示と同じ規則を使うため)", () => {
    expect(isPropertyCaseDone("sold")).toBe(true);
    expect(isPropertyCaseDone("closed")).toBe(true);
    expect(isPropertyCaseDone("done")).toBe(true); // 旧値
    expect(isPropertyCaseDone("negotiating")).toBe(false);
    expect(isPropertyCaseDone(null)).toBe(false);
    expect(isPropertyCaseDone(undefined)).toBe(false);
    // 見た目と同じ判断であること(規則が二重化していない)。
    for (const cs of ["sold", "closed", "done", "negotiating", null]) {
      const style = propertyMarkerStyle({ propertyType: "house", caseStatus: cs });
      expect(style.glyph === PROPERTY_DONE_GLYPH, String(cs)).toBe(
        isPropertyCaseDone(cs),
      );
    }
  });

  it("同じ入力なら常に同じ結果(副作用なし)", () => {
    const input = { propertyType: "store", caseStatus: "negotiating" };
    expect(propertyMarkerStyle(input)).toEqual(propertyMarkerStyle(input));
  });
});
