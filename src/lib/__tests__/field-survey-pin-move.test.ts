/**
 * ピンの位置直し(発注者決定 2026-07-28 決定8・実装は 2026-08-24)。
 *
 * 現場で「撮った直後に、家の上へピンをドラッグして直す」ための土台。
 * ⚠決定9=**位置の変更は記録に残さない**。既存の `field_survey_pin_update` 監査は
 *   種類/状況/メモ/紐付けの変更で発火するので、**座標だけは changedFields に
 *   含めない**(含めると自動的に残ってしまう)。
 */
import { describe, it, expect } from "vitest";
import { patchFieldSurveyPinSchema } from "@/lib/validators";
import { buildPinMovePatch } from "@/lib/field-survey-pin-util";

describe("patchFieldSurveyPinSchema: 座標の受け付け", () => {
  it("緯度と経度の組を受け付ける(これまでは 422 で弾いていた)", () => {
    const r = patchFieldSurveyPinSchema.parse({ lat: 35.6812, lng: 139.7671 });
    expect(r).toEqual({ lat: 35.6812, lng: 139.7671 });
  });

  it("片方だけは受け付けない(半端な位置で保存されない)", () => {
    expect(() => patchFieldSurveyPinSchema.parse({ lat: 35.6812 })).toThrow();
    expect(() => patchFieldSurveyPinSchema.parse({ lng: 139.7671 })).toThrow();
  });

  it("地球の範囲を外れる値は受け付けない", () => {
    for (const bad of [
      { lat: 91, lng: 139 },
      { lat: -91, lng: 139 },
      { lat: 35, lng: 181 },
      { lat: 35, lng: -181 },
    ]) {
      expect(() => patchFieldSurveyPinSchema.parse(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("数値でない値は受け付けない(文字列の混入で 0 に化けない)", () => {
    expect(() =>
      patchFieldSurveyPinSchema.parse({ lat: "35.6", lng: "139.7" }),
    ).toThrow();
    expect(() =>
      patchFieldSurveyPinSchema.parse({ lat: Number.NaN, lng: 139 }),
    ).toThrow();
  });

  it("端の値(±90 / ±180)は受け付ける", () => {
    expect(() => patchFieldSurveyPinSchema.parse({ lat: 90, lng: 180 })).not.toThrow();
    expect(() => patchFieldSurveyPinSchema.parse({ lat: -90, lng: -180 })).not.toThrow();
  });

  it("従来の項目はそのまま通り、知らない項目は弾く", () => {
    expect(() => patchFieldSurveyPinSchema.parse({ status: "closed" })).not.toThrow();
    expect(() =>
      patchFieldSurveyPinSchema.parse({ lat: 35, lng: 139, accuracy: 5 }),
    ).toThrow();
  });

  it("空の更新は受け付けない(何も指定しない PATCH を通さない)", () => {
    expect(() => patchFieldSurveyPinSchema.parse({})).toThrow();
  });

  it("座標と他の項目を同時に送ることもできる", () => {
    const r = patchFieldSurveyPinSchema.parse({
      lat: 35.6,
      lng: 139.7,
      status: "closed",
    });
    expect(r).toEqual({ lat: 35.6, lng: 139.7, status: "closed" });
  });
});

describe("buildPinMovePatch: 送る中身を決める", () => {
  it("動かした先の座標だけを送る(他の項目を巻き込まない)", () => {
    expect(buildPinMovePatch(35.6812, 139.7671)).toEqual({
      lat: 35.6812,
      lng: 139.7671,
    });
  });

  it("座標が壊れていたら送らない(null)", () => {
    expect(buildPinMovePatch(Number.NaN, 139.7)).toBeNull();
    expect(buildPinMovePatch(35.6, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("地球の範囲を外れていたら送らない(サーバーに 422 を打たせない)", () => {
    expect(buildPinMovePatch(91, 139)).toBeNull();
    expect(buildPinMovePatch(35, -181)).toBeNull();
  });

  it("端の値は送る", () => {
    expect(buildPinMovePatch(90, 180)).toEqual({ lat: 90, lng: 180 });
  });

  it("作った中身はそのまま API の検証を通る(両者の規則が食い違わない)", () => {
    const patch = buildPinMovePatch(35.681236, 139.767125);
    expect(patch).not.toBeNull();
    expect(() => patchFieldSurveyPinSchema.parse(patch)).not.toThrow();
  });
});
