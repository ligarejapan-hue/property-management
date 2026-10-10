import { describe, it, expect, vi } from "vitest";
import {
  addressLooseKey,
  findReportCandidates,
  rankCandidates,
  roomKey,
  type CandidateProperty,
} from "../candidates";

const p = (id: string, o: Partial<CandidateProperty>): CandidateProperty => ({
  id,
  address: "東京都世田谷区太子堂4-12-3",
  buildingName: null,
  roomNo: null,
  propertyType: "apartment_unit",
  buildingId: null,
  ...o,
});

const clues = {
  buildingName: "東急サンプルハイツ弐番館",
  roomNo: "305",
  address: "東京都世田谷区太子堂4丁目12ー3",
};

describe("比べる形", () => {
  it("部屋番号: 全角・号室・空白を吸収", () => {
    expect(roomKey("３０５号室")).toBe("305");
    expect(roomKey(" 305 ")).toBe("305");
    expect(roomKey("")).toBeNull();
  });
  it("所在地: 「4丁目12ー3」「4-12-3」「4丁目12番3号」は同じ", () => {
    const k = addressLooseKey("東京都世田谷区太子堂4丁目12ー3");
    expect(k).toBe("東京都世田谷区太子堂4-12-3");
    expect(addressLooseKey("東京都世田谷区太子堂４－１２－３")).toBe(k);
    expect(addressLooseKey("〒154-0004 東京都世田谷区太子堂4丁目12番3号")).toBe(k);
  });
});

describe("rankCandidates", () => {
  it("★名前+部屋が一致した物件を先頭に。名前だけ(部屋違い)も人が見られるよう出す", () => {
    const r = rankCandidates(clues, [
      p("other-room", { buildingName: "東急サンプルハイツ弐番館", roomNo: "201" }),
      p("hit", { buildingName: "東急サンプルハイツ 弐番館", roomNo: "３０５" }),
      p("unrelated", { address: "東京都A区B1-2-3", buildingName: "別の建物", roomNo: "305" }),
    ]);
    expect(r.map((c) => [c.propertyId, c.match])).toEqual([
      ["hit", "name_room"],
      ["other-room", "name"],
    ]);
  });

  it("名前が無くても、所在地(書き方違い)+部屋で候補に出す", () => {
    const r = rankCandidates(clues, [p("a", { roomNo: "305", buildingName: null })]);
    expect(r).toEqual([expect.objectContaining({ propertyId: "a", match: "address_room" })]);
  });

  it("所在地が建物名・部屋まで含む物件も前方一致で拾う", () => {
    const r = rankCandidates({ ...clues, buildingName: null, roomNo: null }, [
      p("a", { address: "東京都世田谷区太子堂4-12-3東急サンプルハイツ305" }),
    ]);
    expect(r[0]?.match).toBe("address");
  });

  it("手がかりが何も合わなければ候補なし", () => {
    expect(rankCandidates(clues, [p("x", { address: "東京都A区B1-2-3", buildingName: "別" })])).toEqual([]);
  });
});

describe("findReportCandidates(DB から読む)", () => {
  it("同じ比べる形の棟の物件・物件名・所在地の頭で読み、アーカイブ済みは除く", async () => {
    const building = { findMany: vi.fn(async () => [{ id: "b1" }]) };
    const property = {
      findMany: vi.fn(async () => [p("hit", { buildingId: "b1", buildingName: "東急サンプルハイツ弐番館", roomNo: "305" })]),
    };
    const r = await findReportCandidates({ building, property }, clues, { scopeWhere: {}, canAccess: () => true });
    expect(r[0]).toMatchObject({ propertyId: "hit", match: "name_room" });
    const where = (property.findMany.mock.calls[0] as unknown as [{ where: { AND: [{ isArchived: boolean }, { OR: unknown[] }, unknown] } }])[0].where;
    expect(where.AND[0]).toEqual({ isArchived: false });
    expect(where.AND[1].OR).toEqual(
      expect.arrayContaining([
        { buildingId: { in: ["b1"] } },
        { buildingName: { contains: "東急サン" } },
        { address: { contains: "東京都世田谷区太子堂" } },
      ]),
    );
  });

  it("★呼び出した人が開けない物件は候補に出さない(担当外の住所・建物名を見せない・@codex PR#500)", async () => {
    const building = { findMany: vi.fn(async () => []) };
    const property = {
      findMany: vi.fn(async () => [
        p("mine", { buildingName: "東急サンプルハイツ弐番館", roomNo: "305", createdBy: "me", assignedTo: null }),
        p("others", { buildingName: "東急サンプルハイツ弐番館", roomNo: "305", createdBy: "x", assignedTo: "y" }),
      ]),
    };
    const scopeWhere = { OR: [{ createdBy: "me" }, { assignedTo: "me" }] };
    const r = await findReportCandidates({ building, property }, clues, { scopeWhere, canAccess: (q) => q.createdBy === "me" });
    // ⚠件数で切る前に DB の条件として効いている(@codex PR#500 2巡目)
    const where = (property.findMany.mock.calls[0] as unknown as [{ where: { AND: unknown[] } }])[0].where;
    expect(where.AND).toContainEqual(scopeWhere);
    expect(r.map((c) => c.propertyId)).toEqual(["mine"]);
  });

  it("手がかりが無ければ DB を引かない", async () => {
    const building = { findMany: vi.fn() };
    const property = { findMany: vi.fn() };
    expect(await findReportCandidates({ building, property }, { buildingName: null, roomNo: null, address: null }, { scopeWhere: {}, canAccess: () => true })).toEqual([]);
    expect(property.findMany).not.toHaveBeenCalled();
  });
});
