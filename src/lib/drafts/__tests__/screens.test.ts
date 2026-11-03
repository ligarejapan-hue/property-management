import { describe, it, expect } from "vitest";
import {
  EMPTY_NEW_PROPERTY_DRAFT,
  isNewPropertyDraftEmpty,
  parseNewPropertyDraft,
} from "../screens/new-property";
import {
  changedValues,
  decideEditDraftOnLoad,
  isPropertyEditDraftEmpty,
  mergeDraftIntoInitial,
  parsePropertyEditDraft,
} from "../screens/property-edit";

describe("新規物件登録の控え", () => {
  it("空の控えは空と判定・1文字でも入れば空でない", () => {
    expect(isNewPropertyDraftEmpty(EMPTY_NEW_PROPERTY_DRAFT)).toBe(true);
    expect(isNewPropertyDraftEmpty({ ...EMPTY_NEW_PROPERTY_DRAFT, note: "x" })).toBe(false);
    expect(isNewPropertyDraftEmpty({ ...EMPTY_NEW_PROPERTY_DRAFT, buildingChoice: { kind: "new" } })).toBe(false);
  });
  it("往復して同じ・形違いは null", () => {
    const d = { ...EMPTY_NEW_PROPERTY_DRAFT, propertyType: "apartment_unit", address: "東京都", buildingChoice: { kind: "existing" as const, buildingId: "b1" } };
    expect(parseNewPropertyDraft(JSON.parse(JSON.stringify(d)))).toEqual(d);
    expect(parseNewPropertyDraft({ ...d, address: 1 })).toBeNull();
    expect(parseNewPropertyDraft({ ...d, buildingChoice: { kind: "existing" } })).toBeNull();
    expect(parseNewPropertyDraft(null)).toBeNull();
  });
});

describe("物件の編集の控え", () => {
  const property = { id: "p1", version: 3, address: "東京都A", note: null, floorArea: 12.5 };
  it("changedValues: 開いた時点の値と違う欄だけ(null は空文字として比べる)", () => {
    expect(changedValues({ address: "東京都A", note: "", floorArea: "12.5" }, property)).toEqual({});
    expect(changedValues({ address: "東京都B", note: "メモ", floorArea: "12.5" }, property)).toEqual({ address: "東京都B", note: "メモ" });
  });
  it("空判定", () => {
    expect(isPropertyEditDraftEmpty({ propertyId: "p1", baseVersion: 3, changed: {}, buildingChoice: { kind: "auto" } })).toBe(true);
    expect(isPropertyEditDraftEmpty({ propertyId: "p1", baseVersion: 3, changed: { note: "x" }, buildingChoice: { kind: "auto" } })).toBe(false);
  });
  it("parse: 往復・形違い", () => {
    const d = { propertyId: "p1", baseVersion: 3, changed: { note: "x" }, buildingChoice: { kind: "auto" as const } };
    // 読んだ控えは円の欄を円で持つ印(yen: true)が付く(2026-11-03)。他は往復で変わらない。
    expect(parsePropertyEditDraft(JSON.parse(JSON.stringify(d)))).toEqual({ ...d, yen: true });
    const dy = { ...d, yen: true as const };
    expect(parsePropertyEditDraft(JSON.parse(JSON.stringify(dy)))).toEqual(dy);
    expect(parsePropertyEditDraft({ ...d, baseVersion: "3" })).toBeNull();
    expect(parsePropertyEditDraft({ ...d, changed: { note: 1 } })).toBeNull();
    expect(parsePropertyEditDraft({ ...d, yen: false })).toBeNull();
  });
  it("parse: 円にする前の控え(yen なし)の価格・うち消費税は万円→円に直す", () => {
    const legacy = {
      propertyId: "p1",
      baseVersion: 3,
      changed: { salePrice: "3280.15", saleTaxAmount: "300", note: "3280.15", landArea: "12.5" },
      buildingChoice: { kind: "auto" as const },
    };
    expect(parsePropertyEditDraft(legacy)).toEqual({
      ...legacy,
      changed: { salePrice: "32801500", saleTaxAmount: "3000000", note: "3280.15", landArea: "12.5" },
      yen: true,
    });
    // 空にした欄は空のまま
    expect(parsePropertyEditDraft({ ...legacy, changed: { salePrice: "" } })?.changed).toEqual({ salePrice: "" });
  });
  it("parse: 円の控え(yen: true)は直さない(二重に掛けない)", () => {
    const d = {
      propertyId: "p1",
      baseVersion: 3,
      changed: { salePrice: "32801500", saleTaxAmount: "3000000" },
      buildingChoice: { kind: "auto" as const },
      yen: true as const,
    };
    expect(parsePropertyEditDraft(d)).toEqual(d);
  });
  it("changedValues: 価格・うち消費税は物件の万円を円に直して比べる(開いただけで変えた扱いにしない)", () => {
    const p = { ...property, salePrice: "3280.15", saleTaxAmount: null };
    expect(changedValues({ salePrice: "32801500", saleTaxAmount: "" }, p)).toEqual({});
    expect(changedValues({ salePrice: "32801501", saleTaxAmount: "3000000" }, p)).toEqual({ salePrice: "32801501", saleTaxAmount: "3000000" });
  });
  it("mergeDraftIntoInitial: 物件と版が同じなら重ねる・違えば重ねない", () => {
    const initial = { address: "東京都A", note: "" };
    const d = { propertyId: "p1", baseVersion: 3, changed: { note: "x" }, buildingChoice: { kind: "auto" as const } };
    expect(mergeDraftIntoInitial(initial, d, "p1", 3)).toEqual({ values: { address: "東京都A", note: "x" }, applied: true });
    expect(mergeDraftIntoInitial(initial, d, "p1", 4)).toEqual({ values: initial, applied: false });
    expect(mergeDraftIntoInitial(initial, d, "p2", 3)).toEqual({ values: initial, applied: false });
    expect(mergeDraftIntoInitial(initial, null, "p1", 3)).toEqual({ values: initial, applied: false });
  });
  it("decideEditDraftOnLoad: 無し/開き直す/版違い", () => {
    const d = { propertyId: "p1", baseVersion: 3, changed: { note: "x" }, buildingChoice: { kind: "auto" as const } };
    expect(decideEditDraftOnLoad(null, "p1", 3)).toBe("none");
    expect(decideEditDraftOnLoad(d, "p1", 3)).toBe("reopen");
    expect(decideEditDraftOnLoad(d, "p1", 4)).toBe("stale");
    expect(decideEditDraftOnLoad(d, "p2", 3)).toBe("none");
  });
});
