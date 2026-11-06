import { describe, expect, it } from "vitest";
import { detachCommentForNew, detachCommentForOriginal, detachedPropertyType, planParcelDetach } from "../property-parcel-detach";
import { commentBodyParts } from "@/components/properties/comment-tab";

const row = (id: string, kind: "land" | "building", number: string, o: { location?: string | null; area?: number | null; realEstateNumber?: string | null } = {}) => ({
  id, kind, location: o.location ?? null, number, realEstateNumber: o.realEstateNumber ?? null, area: o.area ?? null,
});
const P = {
  propertyType: "house", address: "架空県架空市架空町一丁目5-6", postalCode: "100-0001",
  extraParcels: [row("a", "land", "1番2", { area: 30.5, realEstateNumber: "123" }), row("b", "building", "1番2の1", { location: "架空市架空町二丁目", area: 60 })],
};
const ID = "11111111-1111-4111-8111-111111111111";

describe("この筆を別の物件にする(2026-11-06 3回目の3つ目)", () => {
  it("★土地の行: 新しい土地の物件の1筆目に(所在が空なら元の住所と郵便番号)・行は元の物件から外す", () => {
    const r = planParcelDetach(P, "a");
    if (!r.ok) throw new Error();
    expect(r.fields).toEqual({
      propertyType: "land", address: P.address, postalCode: "100-0001", lotNumber: "1番2", buildingNumber: null,
      realEstateNumber: "123", landArea: 30.5, totalFloorArea: null,
    });
    expect(r.remaining.map((x) => x.id)).toEqual(["b"]);
  });
  it("建物の行: 元の種別の1棟目に・所在を入れた行は郵便番号を写さない", () => {
    const r = planParcelDetach(P, "b");
    if (!r.ok) throw new Error();
    expect(r.fields).toMatchObject({ propertyType: "house", address: "架空市架空町二丁目", postalCode: null, lotNumber: null, buildingNumber: "1番2の1", totalFloorArea: 60, landArea: null });
  });
  it("種別: 土地・不明の物件の建物は戸建", () => {
    expect(detachedPropertyType("building", "land")).toBe("house");
    expect(detachedPropertyType("building", "unknown")).toBe("house");
    expect(detachedPropertyType("building", "apartment_building")).toBe("apartment_building");
    expect(detachedPropertyType("land", "house")).toBe("land");
  });
  it("無い行は止める", () => {
    expect(planParcelDetach(P, "zzz").ok).toBe(false);
  });
  it("★両方のコメントに相手の物件へのリンク(画面では押せる)", () => {
    const r = planParcelDetach(P, "b");
    if (!r.ok) throw new Error();
    const a = detachCommentForOriginal(r.row, ID);
    expect(a).toBe(`この物件の建物 架空市架空町二丁目 1番2の1を別の物件にしました：/properties/${ID}`);
    expect(detachCommentForNew(r.row, ID)).toContain(`/properties/${ID}`);
    expect(commentBodyParts(a)).toEqual([{ text: "この物件の建物 架空市架空町二丁目 1番2の1を別の物件にしました：" }, { href: `/properties/${ID}` }]);
  });
  it("コメントのリンク: この画面の物件だけ・ほかの URL や形の違う id はリンクにしない", () => {
    expect(commentBodyParts("https://example.com/x を見て")).toEqual([{ text: "https://example.com/x を見て" }]);
    expect(commentBodyParts("/properties/123")).toEqual([{ text: "/properties/123" }]);
    expect(commentBodyParts(`/properties/${ID}x`)).toEqual([{ text: `/properties/${ID}x` }]);
  });
});
