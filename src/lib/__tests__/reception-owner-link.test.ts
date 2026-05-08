import { describe, it, expect } from "vitest";
import {
  isReceptionOwnerJobRow,
  parseRecoveredOwners,
  hasUsableOwnerInfo,
  calcPropertyUpdates,
  RECEPTION_OWNER_LINK_DATA_KEY,
} from "../reception-owner-link";

describe("isReceptionOwnerJobRow", () => {
  it("jobType=owner_csv かつ 受付帳×所有者固有マーカ有り → true", () => {
    expect(
      isReceptionOwnerJobRow("owner_csv", { 所有者CSV物件住所: "東京都..." }),
    ).toBe(true);
    expect(isReceptionOwnerJobRow("owner_csv", { ownerCount: "2" })).toBe(true);
    expect(
      isReceptionOwnerJobRow("owner_csv", {
        [RECEPTION_OWNER_LINK_DATA_KEY]: "[]",
      }),
    ).toBe(true);
  });

  it("matchKey 単独では false（汎用キーのため受付帳×所有者と断定しない）", () => {
    expect(isReceptionOwnerJobRow("owner_csv", { matchKey: "key" })).toBe(false);
  });

  it("jobType=owner_csv だが マーカ無し → false（純粋な所有者CSV取込）", () => {
    expect(isReceptionOwnerJobRow("owner_csv", { 氏名: "田中" })).toBe(false);
    expect(isReceptionOwnerJobRow("owner_csv", { name: "Tanaka" })).toBe(false);
    expect(isReceptionOwnerJobRow("owner_csv", {})).toBe(false);
  });

  it("jobType が owner_csv 以外 → 常に false", () => {
    expect(
      isReceptionOwnerJobRow("property_csv", { 所有者CSV物件住所: "x" }),
    ).toBe(false);
    expect(
      isReceptionOwnerJobRow("dm_history_csv", { ownerCount: "1" }),
    ).toBe(false);
    expect(
      isReceptionOwnerJobRow("registry_pdf", {
        [RECEPTION_OWNER_LINK_DATA_KEY]: "[]",
      }),
    ).toBe(false);
  });

  it("rawData が null / undefined → false", () => {
    expect(isReceptionOwnerJobRow("owner_csv", null)).toBe(false);
    expect(isReceptionOwnerJobRow("owner_csv", undefined)).toBe(false);
  });
});

describe("parseRecoveredOwners", () => {
  it("__owner_link_data から所有者配列を復元する", () => {
    const rawData = {
      [RECEPTION_OWNER_LINK_DATA_KEY]: JSON.stringify([
        { name: "田中太郎", address: "東京都...", zip: "100-0001" },
        { name: "佐藤花子", address: null, zip: null },
      ]),
    };
    const owners = parseRecoveredOwners(rawData);
    expect(owners).toEqual([
      { name: "田中太郎", address: "東京都...", zip: "100-0001" },
      { name: "佐藤花子", address: null, zip: null },
    ]);
  });

  it("name 空 / 不正な要素は除外する", () => {
    const rawData = {
      [RECEPTION_OWNER_LINK_DATA_KEY]: JSON.stringify([
        { name: "田中" },
        { name: "" },
        { name: "   " },
        { foo: "bar" },
        null,
      ]),
    };
    expect(parseRecoveredOwners(rawData)).toEqual([
      { name: "田中", address: null, zip: null },
    ]);
  });

  it("address / zip の空文字は null に正規化", () => {
    const rawData = {
      [RECEPTION_OWNER_LINK_DATA_KEY]: JSON.stringify([
        { name: "山田", address: "  ", zip: "" },
      ]),
    };
    expect(parseRecoveredOwners(rawData)).toEqual([
      { name: "山田", address: null, zip: null },
    ]);
  });

  it("__owner_link_data が無い / null / 空文字 / 非JSON → 空配列", () => {
    expect(parseRecoveredOwners(null)).toEqual([]);
    expect(parseRecoveredOwners(undefined)).toEqual([]);
    expect(parseRecoveredOwners({})).toEqual([]);
    expect(
      parseRecoveredOwners({ [RECEPTION_OWNER_LINK_DATA_KEY]: "" }),
    ).toEqual([]);
    expect(
      parseRecoveredOwners({ [RECEPTION_OWNER_LINK_DATA_KEY]: "not json" }),
    ).toEqual([]);
  });

  it("配列でない JSON → 空配列", () => {
    expect(
      parseRecoveredOwners({
        [RECEPTION_OWNER_LINK_DATA_KEY]: JSON.stringify({ name: "x" }),
      }),
    ).toEqual([]);
  });
});

describe("hasUsableOwnerInfo", () => {
  it("name を持つ所有者が1件以上 → true", () => {
    expect(hasUsableOwnerInfo([{ name: "田中", address: null, zip: null }])).toBe(
      true,
    );
    expect(
      hasUsableOwnerInfo([
        { name: "", address: null, zip: null },
        { name: "佐藤", address: "x", zip: null },
      ]),
    ).toBe(true);
  });

  it("空配列 / name 全部空 → false", () => {
    expect(hasUsableOwnerInfo([])).toBe(false);
    expect(
      hasUsableOwnerInfo([{ name: "", address: "x", zip: null }]),
    ).toBe(false);
    expect(
      hasUsableOwnerInfo([{ name: "   ", address: null, zip: null }]),
    ).toBe(false);
  });
});

describe("calcPropertyUpdates", () => {
  it("既存値が空のみ補完する（既存値は保持）", () => {
    const updates = calcPropertyUpdates(
      { lotNumber: null, buildingNumber: null, roomNo: null },
      { lotNumber: "1-2-3", buildingNumber: "5" },
      "101",
    );
    expect(updates).toEqual({
      lotNumber: "1-2-3",
      buildingNumber: "5",
      roomNo: "101",
    });
  });

  it("既存値があれば上書きしない", () => {
    const updates = calcPropertyUpdates(
      { lotNumber: "old-lot", buildingNumber: "old-bld", roomNo: "old-room" },
      { lotNumber: "new-lot", buildingNumber: "new-bld" },
      "new-room",
    );
    expect(updates).toEqual({});
  });

  it("受付帳側に値が無ければ補完しない", () => {
    const updates = calcPropertyUpdates(
      { lotNumber: null, buildingNumber: null, roomNo: null },
      { lotNumber: null, buildingNumber: null },
      null,
    );
    expect(updates).toEqual({});
  });

  it("一部だけ補完", () => {
    const updates = calcPropertyUpdates(
      { lotNumber: "existing", buildingNumber: null, roomNo: null },
      { lotNumber: "ignored", buildingNumber: "new" },
      null,
    );
    expect(updates).toEqual({ buildingNumber: "new" });
  });
});
