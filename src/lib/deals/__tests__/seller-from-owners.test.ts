import { describe, expect, it, vi } from "vitest";
import {
  fillSellersFromOwners, sellerAccessOf, sellerRowsFromOwners, type SellerAccess, type SellerSourceLink,
} from "../seller-from-owners";

const ALL: SellerAccess = { name: true, address: true, phone: true };
const link = (o: Partial<SellerSourceLink["owner"]> & { name: string }, isPrimary = false): SellerSourceLink => ({
  isPrimary,
  owner: { address: null, currentAddress: null, phone: null, corporateNumber: null, companyRegistryNumber: null, ...o },
});

describe("sellerRowsFromOwners", () => {
  it("主な所有者を先にして、共有名義は複数行にする(持分は空)", () => {
    const rows = sellerRowsFromOwners([link({ name: "乙" }), link({ name: "甲" }, true)], ALL, "自社");
    expect(rows.map((r) => [r.name, r.sortOrder, r.role])).toEqual([["甲", 0, "seller"], ["乙", 1, "seller"]]);
    expect(rows[0]).not.toHaveProperty("shareNum");
    expect(rows[0].isSelf).toBe(false);
  });
  it("住所は現住所があればそれ、なければ登記上の住所", () => {
    const rows = sellerRowsFromOwners([
      link({ name: "甲", address: "登記の住所", currentAddress: "今の住所" }),
      link({ name: "乙", address: "登記の住所", currentAddress: "  " }),
    ], ALL, "自社");
    expect(rows.map((r) => r.address)).toEqual(["今の住所", "登記の住所"]);
  });
  it("法人番号か法人の名前なら法人にする", () => {
    const rows = sellerRowsFromOwners([
      link({ name: "甲", corporateNumber: "1234567890123" }),
      link({ name: "乙株式会社" }),
      link({ name: "丙" }),
    ], ALL, "自社");
    expect(rows.map((r) => r.partyType)).toEqual(["corporation", "corporation", "individual"]);
  });
  it("氏名をそのまま見られない人には1行も作らない", () => {
    expect(sellerRowsFromOwners([link({ name: "甲" })], { ...ALL, name: false }, "自社")).toEqual([]);
  });
  it("住所・電話をそのまま見られない人には、その欄を入れない(伏せた値も保存しない)", () => {
    const [row] = sellerRowsFromOwners(
      [link({ name: "甲", address: "東京都", currentAddress: "神奈川県", phone: "03-0000-0000" })],
      { name: true, address: false, phone: false }, "自社",
    );
    expect(row.address).toBeNull();
    expect(row.phone).toBeNull();
    expect(row.name).toBe("甲");
  });
  it("自社の名前の所有者は入れない(空白の違いは同じとみなす)", () => {
    const rows = sellerRowsFromOwners([link({ name: "リガーレ 株式会社" }), link({ name: "甲" })], ALL, "リガーレ株式会社");
    expect(rows.map((r) => r.name)).toEqual(["甲"]);
  });
  it("欄の長さを超える値は途中で切らずに入れない", () => {
    const rows = sellerRowsFromOwners([
      link({ name: "あ".repeat(201) }),
      link({ name: "甲", address: "あ".repeat(301), phone: "1".repeat(51) }),
    ], ALL, "自社");
    expect(rows).toHaveLength(1);
    expect(rows[0].address).toBeNull();
    expect(rows[0].phone).toBeNull();
  });
});

describe("sellerAccessOf", () => {
  const perm = (resource: string, action: string) => ({ resource, action, granted: true });
  it("owner:read がなければ、表示レベルが全表示でも入れない", () => {
    expect(sellerAccessOf([perm("owner_name", "full"), perm("owner_address", "full"), perm("owner_phone", "full")]))
      .toEqual({ name: false, address: false, phone: false });
  });
  it("一部表示のレベルはそのまま見られるとみなさない", () => {
    expect(sellerAccessOf([perm("owner", "read"), perm("owner_name", "full"), perm("owner_address", "partial"), perm("owner_phone", "masked")]))
      .toEqual({ name: true, address: false, phone: false });
  });
});

describe("fillSellersFromOwners", () => {
  const txOf = (sellers: number, links: SellerSourceLink[]) => ({
    dealParty: { count: vi.fn(async () => sellers), createMany: vi.fn(async () => ({ count: links.length })) },
    propertyOwner: { findMany: vi.fn(async () => links) },
  });
  it("売主がいれば所有者を読まず、何も足さない", async () => {
    const tx = txOf(1, [link({ name: "甲" })]);
    await expect(fillSellersFromOwners(tx as never, { dealId: "d", propertyId: "p", access: ALL, companyName: "自社" }))
      .resolves.toEqual({ status: "sellers_exist", count: 0 });
    expect(tx.propertyOwner.findMany).not.toHaveBeenCalled();
    expect(tx.dealParty.createMany).not.toHaveBeenCalled();
  });
  it("氏名を見られない人の分は所有者を読まない", async () => {
    const tx = txOf(0, [link({ name: "甲" })]);
    await expect(fillSellersFromOwners(tx as never, { dealId: "d", propertyId: "p", access: { ...ALL, name: false }, companyName: "自社" }))
      .resolves.toEqual({ status: "forbidden", count: 0 });
    expect(tx.propertyOwner.findMany).not.toHaveBeenCalled();
  });
  it("売主が空なら足して、件数を返す", async () => {
    const tx = txOf(0, [link({ name: "甲" }), link({ name: "乙" })]);
    await expect(fillSellersFromOwners(tx as never, { dealId: "d", propertyId: "p", access: ALL, companyName: "自社" }))
      .resolves.toEqual({ status: "filled", count: 2 });
    expect(tx.dealParty.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ dealId: "d", name: "甲", sortOrder: 0 }), expect.objectContaining({ dealId: "d", name: "乙", sortOrder: 1 })],
    });
  });
  it("入れる所有者がいなければ何もしない", async () => {
    const tx = txOf(0, []);
    await expect(fillSellersFromOwners(tx as never, { dealId: "d", propertyId: "p", access: ALL, companyName: "自社" }))
      .resolves.toEqual({ status: "no_owners", count: 0 });
    expect(tx.dealParty.createMany).not.toHaveBeenCalled();
  });
});
