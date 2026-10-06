import { describe, it, expect } from "vitest";
import { relinkConfirmMessage, typeChangeUnlinkConfirmMessage } from "@/lib/building-link/relink";

const cur = { id: "b1", name: "パーク第一" };
describe("relinkConfirmMessage", () => {
  it("比べる形が違う名前にしたら確認する", () =>
    expect(relinkConfirmMessage(cur, "別ビル", { kind: "auto" })).toBe("棟「パーク第一」から付け替えます。よろしいですか？"));
  it("比べる形が同じ(打ち直し)なら確認しない", () =>
    expect(relinkConfirmMessage(cur, "パーク第１", { kind: "auto" })).toBeNull());
  it("空にしたら外す確認", () =>
    expect(relinkConfirmMessage(cur, "  ", { kind: "auto" })).toBe("棟「パーク第一」から外します。よろしいですか？"));
  it("同じ棟を選び直したなら確認しない", () =>
    expect(relinkConfirmMessage(cur, "パーク第一", { kind: "existing", buildingId: "b1" })).toBeNull());
  it("別の棟を選んだら確認する", () =>
    expect(relinkConfirmMessage(cur, "別ビル", { kind: "existing", buildingId: "b2" })).not.toBeNull());
  it("新しい棟として登録を選んだら確認する", () =>
    expect(relinkConfirmMessage(cur, "パーク第一", { kind: "new" })).not.toBeNull());
  it("棟につながっていなければ確認しない", () =>
    expect(relinkConfirmMessage(null, "別ビル", { kind: "auto" })).toBeNull());
});

describe("typeChangeUnlinkConfirmMessage(種別を区分マンション以外へ変えると棟から外れる)", () => {
  const msg = "種別を区分マンション以外にすると、棟「パーク第一」から外れます。よろしいですか？";
  it("区分マンションから戸建にしたら確認する", () =>
    expect(typeChangeUnlinkConfirmMessage(cur, "apartment_unit", "house")).toBe(msg));
  it("区分（旧）から土地にしたら確認する", () =>
    expect(typeChangeUnlinkConfirmMessage(cur, "unit", "land")).toBe(msg));
  it("区分（旧）にしたなら棟は残るので確認しない", () =>
    expect(typeChangeUnlinkConfirmMessage(cur, "apartment_unit", "unit")).toBeNull());
  it("種別を変えていなければ確認しない", () =>
    expect(typeChangeUnlinkConfirmMessage(cur, "apartment_unit", "apartment_unit")).toBeNull());
  it("棟につながっていなければ確認しない", () =>
    expect(typeChangeUnlinkConfirmMessage(null, "apartment_unit", "house")).toBeNull());
});
