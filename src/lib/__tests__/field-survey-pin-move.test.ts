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
  it("動かし先と動かし始めた位置の組を受け付ける", () => {
    const body = {
      lat: 35.6812,
      lng: 139.7671,
      fromLat: 35.68,
      fromLng: 139.76,
    };
    expect(patchFieldSurveyPinSchema.parse(body)).toEqual(body);
  });

  it("⚠動かし始めた位置を省略した移動は受け付けない(@codex #410 R3 P2)", () => {
    // 省略を許すと、その呼び出しだけ競合の検出をすり抜ける。
    expect(() =>
      patchFieldSurveyPinSchema.parse({ lat: 35.6812, lng: 139.7671 }),
    ).toThrow();
    // 動かし始めた位置だけでも更新できない。
    expect(() =>
      patchFieldSurveyPinSchema.parse({ fromLat: 35.68, fromLng: 139.76 }),
    ).toThrow();
    // from も組で送る。
    expect(() =>
      patchFieldSurveyPinSchema.parse({
        lat: 35.6812,
        lng: 139.7671,
        fromLat: 35.68,
      }),
    ).toThrow();
  });

  it("片方だけは受け付けない(半端な位置で保存されない)", () => {
    expect(() => patchFieldSurveyPinSchema.parse({ lat: 35.6812 })).toThrow();
    expect(() => patchFieldSurveyPinSchema.parse({ lng: 139.7671 })).toThrow();
  });

  it("地球の範囲を外れる値は受け付けない", () => {
    for (const bad of [
      { lat: 91, lng: 139, fromLat: 35, fromLng: 139 },
      { lat: -91, lng: 139, fromLat: 35, fromLng: 139 },
      { lat: 35, lng: 181, fromLat: 35, fromLng: 139 },
      { lat: 35, lng: -181, fromLat: 35, fromLng: 139 },
      { lat: 35, lng: 139, fromLat: 91, fromLng: 139 },
    ]) {
      expect(() => patchFieldSurveyPinSchema.parse(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("数値でない値は受け付けない(文字列の混入で 0 に化けない)", () => {
    expect(() =>
      patchFieldSurveyPinSchema.parse({
        lat: "35.6",
        lng: "139.7",
        fromLat: 35,
        fromLng: 139,
      }),
    ).toThrow();
    expect(() =>
      patchFieldSurveyPinSchema.parse({
        lat: Number.NaN,
        lng: 139,
        fromLat: 35,
        fromLng: 139,
      }),
    ).toThrow();
  });

  it("端の値(±90 / ±180)は受け付ける", () => {
    expect(() =>
      patchFieldSurveyPinSchema.parse({
        lat: 90,
        lng: 180,
        fromLat: -90,
        fromLng: -180,
      }),
    ).not.toThrow();
  });

  it("従来の項目はそのまま通り、知らない項目は弾く", () => {
    expect(() => patchFieldSurveyPinSchema.parse({ status: "closed" })).not.toThrow();
    expect(() =>
      patchFieldSurveyPinSchema.parse({
        lat: 35,
        lng: 139,
        fromLat: 35,
        fromLng: 139,
        accuracy: 5,
      }),
    ).toThrow();
  });

  it("空の更新は受け付けない(何も指定しない PATCH を通さない)", () => {
    expect(() => patchFieldSurveyPinSchema.parse({})).toThrow();
  });

  it("座標と他の項目を同時に送ることもできる", () => {
    const body = {
      lat: 35.6,
      lng: 139.7,
      fromLat: 35.5,
      fromLng: 139.6,
      status: "closed" as const,
    };
    expect(patchFieldSurveyPinSchema.parse(body)).toEqual(body);
  });
});

describe("buildPinMovePatch: 送る中身を決める", () => {
  it("動かした先と、動かし始めた位置を送る(他の項目を巻き込まない)", () => {
    // ⚠from* = 画面が実際に見ていた位置。サーバーはこれを条件に更新するので、
    //   先に他の人が動かしていれば 409 になる(@codex #410 R3 P2)。
    expect(buildPinMovePatch(35.6812, 139.7671, 35.68, 139.76)).toEqual({
      lat: 35.6812,
      lng: 139.7671,
      fromLat: 35.68,
      fromLng: 139.76,
    });
  });

  it("座標が壊れていたら送らない(null)", () => {
    expect(buildPinMovePatch(Number.NaN, 139.7, 35, 139)).toBeNull();
    expect(
      buildPinMovePatch(35.6, Number.POSITIVE_INFINITY, 35, 139),
    ).toBeNull();
  });

  it("動かし始めた位置が壊れていても送らない", () => {
    expect(buildPinMovePatch(35.6, 139.7, Number.NaN, 139)).toBeNull();
    expect(buildPinMovePatch(35.6, 139.7, 35, Number.NaN)).toBeNull();
  });

  it("地球の範囲を外れていたら送らない(サーバーに 422 を打たせない)", () => {
    expect(buildPinMovePatch(91, 139, 35, 139)).toBeNull();
    expect(buildPinMovePatch(35, -181, 35, 139)).toBeNull();
    expect(buildPinMovePatch(35, 139, 91, 139)).toBeNull();
    expect(buildPinMovePatch(35, 139, 35, -181)).toBeNull();
  });

  it("端の値は送る", () => {
    expect(buildPinMovePatch(90, 180, -90, -180)).toEqual({
      lat: 90,
      lng: 180,
      fromLat: -90,
      fromLng: -180,
    });
  });

  it("作った中身はそのまま API の検証を通る(両者の規則が食い違わない)", () => {
    const patch = buildPinMovePatch(35.681236, 139.767125, 35.681, 139.767);
    expect(patch).not.toBeNull();
    expect(() => patchFieldSurveyPinSchema.parse(patch)).not.toThrow();
  });
});
