import { describe, expect, it } from "vitest";
import {
  fingerprintRegistryTarget,
  parseTargetParcelId,
  purchaseIdentifierFor,
  registryTargetView,
} from "../parcel-target";
import { fingerprintProperty } from "../candidate-cache";

const row = (id: string, kind: "land" | "building", number: string, o: { location?: string | null; realEstateNumber?: string | null; area?: number | null } = {}) => ({
  id, kind, location: o.location ?? null, number, realEstateNumber: o.realEstateNumber ?? null, area: o.area ?? null,
});
const P = {
  address: "架空県架空市架空町一丁目5-6",
  lotNumber: "1番1",
  buildingNumber: "1番1",
  realEstateNumber: "1234567890123",
  extraParcels: [row("a", "land", "1番2"), row("b", "building", "1番1の2", { location: "架空県架空市架空町二丁目" })],
};

describe("取得する土地・建物の指定(2026-11-06 2回目後半)", () => {
  it("指定なし: 物件の欄そのまま(今までどおり)", () => {
    expect(registryTargetView(P, null)).toEqual({
      address: P.address, lotNumber: "1番1", buildingNumber: "1番1", realEstateNumber: "1234567890123", parcel: null,
    });
  });
  it("足した行: その行の種類の番号だけ・所在は行(空なら物件の住所)・不動産番号は使わない", () => {
    expect(registryTargetView(P, "a")).toMatchObject({ address: P.address, lotNumber: "1番2", buildingNumber: null, realEstateNumber: null });
    expect(registryTargetView(P, "b")).toMatchObject({ address: "架空県架空市架空町二丁目", lotNumber: null, buildingNumber: "1番1の2", realEstateNumber: null });
    // ⚠行に不動産番号があっても所在で取る(番号での取得は作らない=発注者判断)。
    const withNo = { ...P, extraParcels: [row("a", "land", "1番2", { realEstateNumber: "999" })] };
    expect(registryTargetView(withNo, "a")?.realEstateNumber).toBeNull();
  });
  it("消された行・壊れた値は null(取得しない)", () => {
    expect(registryTargetView(P, "zzz")).toBeNull();
    expect(registryTargetView({ ...P, extraParcels: "壊れた" }, "a")).toBeNull();
  });

  it("指紋: 指定なしは今の指紋と同じ(一括・前からの候補をそのまま使える)", () => {
    expect(fingerprintRegistryTarget(P, null)).toBe(fingerprintProperty(P));
  });
  it("★指紋: 行を指定すると1筆目と別になり、行を直すと変わる・ほかの行を直しても変わらない", () => {
    const fa = fingerprintRegistryTarget(P, "a");
    expect(fa).not.toBe(fingerprintRegistryTarget(P, null));
    expect(fa).not.toBe(fingerprintRegistryTarget(P, "b"));
    const editedA = { ...P, extraParcels: [row("a", "land", "1番3"), P.extraParcels[1]] };
    expect(fingerprintRegistryTarget(editedA, "a")).not.toBe(fa);
    const editedB = { ...P, extraParcels: [P.extraParcels[0], row("b", "building", "9番", { location: "別" })] };
    expect(fingerprintRegistryTarget(editedB, "a")).toBe(fa);
    // 住所を直すと、所在が空の行の指紋も変わる(物件の住所で探すため)。
    expect(fingerprintRegistryTarget({ ...P, address: "別の住所" }, "a")).not.toBe(fa);
    // 行が消えたら別の値(候補を使わせない)。
    expect(fingerprintRegistryTarget({ ...P, extraParcels: [] }, "a")).not.toBe(fa);
  });

  it("★二重課金の鍵: 1筆目は今までどおり・行は種類つき(土地 1番1 と建物 1番1 を同じにしない)", () => {
    expect(purchaseIdentifierFor(registryTargetView(P, null)!, "1番1")).toBe("1番1");
    expect(purchaseIdentifierFor(registryTargetView(P, "a")!, "1番2")).toBe("land:a:1番2");
    expect(purchaseIdentifierFor(registryTargetView(P, "b")!, "1番1の2")).toBe("building:b:1番1の2");
  });
  it("★所在が違う同じ番号の行は別の鍵・同じ行は所在の書き方を直しても同じ鍵(@codex P2)", () => {
    const twins = { ...P, extraParcels: [row("x", "land", "2番", { location: "架空町二丁目" }), row("y", "land", "2番", { location: "架空町三丁目" })] };
    const kx = purchaseIdentifierFor(registryTargetView(twins, "x")!, "2番");
    expect(kx).not.toBe(purchaseIdentifierFor(registryTargetView(twins, "y")!, "2番"));
    const renamed = { ...twins, extraParcels: [row("x", "land", "2番", { location: "架空町2丁目" }), twins.extraParcels[1]] };
    expect(purchaseIdentifierFor(registryTargetView(renamed, "x")!, "2番")).toBe(kx);
  });

  it("受け取る値: 省略=指定なし・文字(64字まで)=行・それ以外は不正", () => {
    expect(parseTargetParcelId(undefined)).toEqual({ ok: true, value: null });
    expect(parseTargetParcelId(" a ")).toEqual({ ok: true, value: "a" });
    expect(parseTargetParcelId(null)).toEqual({ ok: false });
    expect(parseTargetParcelId("")).toEqual({ ok: false });
    expect(parseTargetParcelId(1)).toEqual({ ok: false });
    expect(parseTargetParcelId("x".repeat(65))).toEqual({ ok: false });
  });
});
