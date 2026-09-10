import { describe, it, expect } from "vitest";
import {
  resolveOwnerPropertyLink,
  pickSinglePropertyId,
  ownerFilteredPropertyListHref,
} from "../owner-property-link";

const OWNER = "11111111-1111-4111-8111-111111111111";
const PROP = "22222222-2222-4222-8222-222222222222";

describe("resolveOwnerPropertyLink", () => {
  // 件数 × 物件IDの有無 を総当たりで固定する。
  // 画面側に分岐を書くと壊れたリンク(/properties/undefined)が出るため、
  // ここで全組み合わせの結論を決めきる。
  const counts = [-1, 0, 1, 2, 3, 999];
  const ids: Array<string | null> = [null, PROP];

  it("すべての組み合わせで kind と href が矛盾しない", () => {
    for (const propertyOwnerCount of counts) {
      for (const singlePropertyId of ids) {
        const r = resolveOwnerPropertyLink({
          ownerId: OWNER,
          propertyOwnerCount,
          singlePropertyId,
        });
        if (propertyOwnerCount <= 0) {
          expect(r).toEqual({ kind: "none" });
          continue;
        }
        if (propertyOwnerCount === 1 && singlePropertyId !== null) {
          expect(r).toEqual({ kind: "single", href: `/properties/${PROP}` });
          continue;
        }
        expect(r.kind).toBe("many");
        expect((r as { href: string }).href).toBe(
          `/properties?ownerId=${OWNER}`,
        );
      }
    }
  });

  it("1件でも物件IDが分からなければ一覧へ逃がす(壊れたリンクを作らない)", () => {
    const r = resolveOwnerPropertyLink({
      ownerId: OWNER,
      propertyOwnerCount: 1,
      singlePropertyId: null,
    });
    expect(r.kind).toBe("many");
  });

  it("0件はリンクにしない", () => {
    expect(
      resolveOwnerPropertyLink({
        ownerId: OWNER,
        propertyOwnerCount: 0,
        singlePropertyId: null,
      }),
    ).toEqual({ kind: "none" });
  });

  it("ownerId が空なら none(空の絞り込みで全件を見せない)", () => {
    expect(
      resolveOwnerPropertyLink({
        ownerId: "",
        propertyOwnerCount: 3,
        singlePropertyId: null,
      }),
    ).toEqual({ kind: "none" });
  });

  it("href に含まれるのは所有者IDと物件IDだけ(氏名・住所を載せない)", () => {
    const many = resolveOwnerPropertyLink({
      ownerId: OWNER,
      propertyOwnerCount: 5,
      singlePropertyId: null,
    }) as { href: string };
    const single = resolveOwnerPropertyLink({
      ownerId: OWNER,
      propertyOwnerCount: 1,
      singlePropertyId: PROP,
    }) as { href: string };
    expect(many.href).toBe(`/properties?ownerId=${OWNER}`);
    expect(single.href).toBe(`/properties/${PROP}`);
  });
});

describe("ownerFilteredPropertyListHref", () => {
  it("所有者で絞り込んだ物件一覧の URL を組み立てる", () => {
    expect(ownerFilteredPropertyListHref(OWNER)).toBe(
      `/properties?ownerId=${OWNER}`,
    );
  });

  it("resolveOwnerPropertyLink の many/href と同じ値を返す(URL が2箇所で食い違わない)", () => {
    const many = resolveOwnerPropertyLink({
      ownerId: OWNER,
      propertyOwnerCount: 5,
      singlePropertyId: null,
    }) as { href: string };
    expect(ownerFilteredPropertyListHref(OWNER)).toBe(many.href);
  });

  it("ID を URL エンコードする", () => {
    expect(ownerFilteredPropertyListHref("a b")).toBe(
      "/properties?ownerId=a%20b",
    );
  });
});

describe("pickSinglePropertyId", () => {
  it("ちょうど1件のときだけ物件IDを返す", () => {
    expect(pickSinglePropertyId([])).toBeNull();
    expect(pickSinglePropertyId([{ propertyId: PROP }])).toBe(PROP);
    expect(
      pickSinglePropertyId([{ propertyId: PROP }, { propertyId: "x" }]),
    ).toBeNull();
    expect(
      pickSinglePropertyId([
        { propertyId: PROP },
        { propertyId: "x" },
        { propertyId: "y" },
      ]),
    ).toBeNull();
  });
});
