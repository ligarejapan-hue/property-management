/**
 * 調査ピンのマーカー配色 (種別 / 対応済み / 自分・他人) の純ロジック検証。
 *
 * 背景: 全ピンが素の既定マーカーで、種別4種・自分/他人・対応済みの区別が
 * 地図上で一切つかない (現場/事務所双方の最上位指摘)。色 + 1文字グリフで
 * 見分けられるようにする。色覚多様性への配慮としてグリフが色の冗長表現になる。
 */
import { describe, it, expect } from "vitest";
import {
  pinMarkerStyle,
  PIN_TYPE_GLYPHS,
} from "@/lib/field-survey-pin-marker";
import { FIELD_SURVEY_PIN_TYPES } from "@/lib/field-survey-constants";

describe("pinMarkerStyle", () => {
  it("種別4種はそれぞれ異なる背景色を持つ", () => {
    const colors = FIELD_SURVEY_PIN_TYPES.map(
      (t) => pinMarkerStyle({ pinType: t, status: "open", isOwn: true }).background,
    );
    expect(new Set(colors).size).toBe(FIELD_SURVEY_PIN_TYPES.length);
  });

  it("種別ごとに 1 文字グリフを持つ (色覚多様性への冗長表現)", () => {
    for (const t of FIELD_SURVEY_PIN_TYPES) {
      const s = pinMarkerStyle({ pinType: t, status: "open", isOwn: true });
      expect(s.glyph).toBe(PIN_TYPE_GLYPHS[t]);
      expect(s.glyph.length).toBe(1);
    }
    // グリフ自体も種別間で重複しない
    expect(new Set(Object.values(PIN_TYPE_GLYPHS)).size).toBe(
      FIELD_SURVEY_PIN_TYPES.length,
    );
  });

  it("対応済み (closed) は種別によらず灰色 + チェックグリフ", () => {
    for (const t of FIELD_SURVEY_PIN_TYPES) {
      const s = pinMarkerStyle({ pinType: t, status: "closed", isOwn: true });
      expect(s.glyph).toBe("✓");
      expect(s.background).toBe(
        pinMarkerStyle({ pinType: "candidate", status: "closed", isOwn: true })
          .background,
      );
    }
    // open の候補色とは異なる
    expect(
      pinMarkerStyle({ pinType: "candidate", status: "closed", isOwn: true })
        .background,
    ).not.toBe(
      pinMarkerStyle({ pinType: "candidate", status: "open", isOwn: true })
        .background,
    );
  });

  it("他人のピンは白縁・自分のピンは濃色縁 (作成者の見分け)", () => {
    const own = pinMarkerStyle({
      pinType: "candidate",
      status: "open",
      isOwn: true,
    });
    const other = pinMarkerStyle({
      pinType: "candidate",
      status: "open",
      isOwn: false,
    });
    expect(other.borderColor).toBe("#FFFFFF");
    expect(own.borderColor).not.toBe("#FFFFFF");
    // 背景色は同じ (縁だけで区別)
    expect(own.background).toBe(other.background);
  });

  it("未知の種別は安全側の中立色 (例外を出さない)", () => {
    const s = pinMarkerStyle({
      pinType: "mystery",
      status: "open",
      isOwn: true,
    });
    expect(s.background).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(s.glyph.length).toBe(1);
  });

  it("すべての色は 6 桁 hex (Google Maps Pin にそのまま渡せる)", () => {
    for (const t of [...FIELD_SURVEY_PIN_TYPES, "mystery"]) {
      for (const status of ["open", "closed"]) {
        for (const isOwn of [true, false]) {
          const s = pinMarkerStyle({ pinType: t, status, isOwn });
          expect(s.background).toMatch(/^#[0-9A-Fa-f]{6}$/);
          expect(s.borderColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
          expect(s.glyphColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
        }
      }
    }
  });
});
