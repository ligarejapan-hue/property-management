import { describe, it, expect, vi } from "vitest";
import {
  addressLooseKey,
  findReportCandidates,
  compactNameForDb,
  findExactNameIds,
  type CandidateDb,
  roomVariants,
  searchPropertiesForReport,
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

describe("roomVariants(部屋番号の書き方の揺れ)", () => {
  it("★半角/全角 × なし・号・号室・空白+号室 を並べる(15巡目: 含むでは同じ地域の 1101 などに押し出される)", () => {
    expect(roomVariants("101")).toEqual(
      expect.arrayContaining(["101", "101号", "101号室", "101 号室", "１０１", "１０１号室"]),
    );
    expect(roomVariants("101")).not.toContain("1101");
  });
});

/** 名前の完全一致の生 SQL(既定は一致なし)をつける。 */
function withRaw(
  db: Pick<CandidateDb, "building" | "property">,
  rawIds: string[] = [],
  key = "abcマンション",
): CandidateDb {
  return { ...db, $queryRaw: vi.fn(async () => rawIds.map((id) => ({ id, k: key }))) } as unknown as CandidateDb;
}

describe("findExactNameIds(ページ分の名前をまとめて1回で引く・22巡目)", () => {
  it("★複数の名前を1回の問い合わせで引き、名前ごとに分ける", async () => {
    const $queryRaw = vi.fn(async () => [
      { id: "a1", k: "abcマンション" },
      { id: "b1", k: "xyzハイツ" },
      { id: "a2", k: "abcマンション" },
    ]);
    const m = await findExactNameIds({ $queryRaw } as unknown as CandidateDb, ["abcマンション", "xyzハイツ", "abcマンション"]);
    expect($queryRaw).toHaveBeenCalledTimes(1);
    expect(($queryRaw.mock.calls[0] as unknown as [{ values: unknown[] }])[0].values).toEqual([["abcマンション", "xyzハイツ"], 2000]); // 名前ごとの上限は SQL の中(23巡目)
    expect(m.get("abcマンション")).toEqual(["a1", "a2"]);
    expect(m.get("xyzハイツ")).toEqual(["b1"]);
  });

  it("名前が無ければ問い合わせない", async () => {
    const $queryRaw = vi.fn();
    expect((await findExactNameIds({ $queryRaw } as unknown as CandidateDb, [])).size).toBe(0);
    expect($queryRaw).not.toHaveBeenCalled();
  });

  it("★渡された結果があれば findReportCandidates は自分では引かない", async () => {
    const building = { findMany: vi.fn(async () => []) };
    const property = { findMany: vi.fn(async () => []) };
    const db = withRaw({ building, property });
    await findReportCandidates(db, { buildingName: "ABCマンション", roomNo: null, address: null }, {
      scopeWhere: {},
      canAccess: () => true,
      exactNameIds: new Map([["abcマンション", ["x"]]]),
    });
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(JSON.stringify(property.findMany.mock.calls)).toContain('"x"');
  });
});

describe("compactNameForDb", () => {
  it("NFKC・小文字・空白なしにそろえる(DB 側の lower+空白除去と同じ形)", () => {
    expect(compactNameForDb("ＡＢＣ マンション")).toBe("abcマンション");
    expect(compactNameForDb("abc　マンション")).toBe("abcマンション");
    expect(compactNameForDb("A")).toBeNull();
  });
});

describe("findReportCandidates(DB から読む)", () => {
  it("★棟につながっていない物件も、大文字小文字・空白だけ違う名前の完全一致で先に引く(@codex PR#500 19巡目)", async () => {
    const building = { findMany: vi.fn(async () => []) };
    const target = p("unlinked", { buildingName: "abc マンション", roomNo: "101" });
    const property = {
      findMany: vi.fn(async (args: { where: { AND: unknown[] } }) =>
        JSON.stringify(args.where.AND).includes('"unlinked"') ? [target] : [],
      ),
    };
    const db = withRaw({ building, property }, ["unlinked"]);
    const r = await findReportCandidates(db, { buildingName: "ABCマンション", roomNo: "101", address: null }, {
      scopeWhere: {},
      canAccess: () => true,
    });
    expect(r[0]).toMatchObject({ propertyId: "unlinked", match: "name_room" });
    // 生 SQL には比べる形だけを値として渡す(SQL の文には埋め込まない)
    const sql = (db.$queryRaw as unknown as { mock: { calls: [{ values: unknown[] }][] } }).mock.calls[0][0];
    expect(sql.values).toEqual([["abcマンション"], 2000]);
  });


  it("同じ比べる形の棟の物件・物件名・所在地の頭で読み、アーカイブ済みは除く", async () => {
    const building = { findMany: vi.fn(async () => [{ id: "b1" }]) };
    const property = {
      findMany: vi.fn(async () => [p("hit", { buildingId: "b1", buildingName: "東急サンプルハイツ弐番館", roomNo: "305" })]),
    };
    const r = await findReportCandidates(withRaw({ building, property }), clues, { scopeWhere: {}, canAccess: () => true });
    expect(r[0]).toMatchObject({ propertyId: "hit", match: "name_room" });
    const wheres = (property.findMany.mock.calls as unknown as [{ where: { AND: unknown[] } }][]).map((c) => c[0].where.AND);
    for (const w of wheres) expect(w[0]).toEqual({ isArchived: false });
    // 手がかりの種類ごと(同じ棟・名前の頭・所在地の頭)に、まず部屋番号の完全一致つき、次に単独で読む
    const kinds = [
      { buildingId: { in: ["b1"] } },
      { buildingName: { contains: "東急サン", mode: "insensitive" } },
      { address: { contains: "東京都世田谷区太子堂" } },
    ];
    expect(wheres.map((w) => w[1])).toEqual([...kinds, ...kinds]);
    expect(wheres[0][2]).toEqual({ roomNo: { in: roomVariants("305") } });
  });

  it("★広い条件で300件を超えても、部屋番号つき・同じ棟の組を先に読むので古い一致が漏れない(@codex PR#500 14巡目)", async () => {
    const building = { findMany: vi.fn(async () => [{ id: "b1" }]) };
    const old = p("old-exact", { buildingId: "b1", buildingName: "東急サンプルハイツ弐番館", roomNo: "305" });
    const noise = Array.from({ length: 300 }, (_, i) => p(`n${i}`, { address: "東京都世田谷区太子堂4丁目1-1" }));
    const property = {
      findMany: vi.fn(async (args: { where: { AND: unknown[] } }) => {
        const exactRoomInBuilding =
          JSON.stringify(args.where.AND).includes('"roomNo"') && JSON.stringify(args.where.AND).includes('"buildingId"');
        return exactRoomInBuilding ? [old] : noise; // それ以外では新しい300件だけが返る
      }),
    };
    const r = await findReportCandidates(withRaw({ building, property }), clues, { scopeWhere: {}, canAccess: () => true });
    expect(r[0]).toMatchObject({ propertyId: "old-exact", match: "name_room" });
    // 手がかりの種類ごと×(部屋番号の完全一致つき/単独)で、それぞれ300件まで
    expect(property.findMany).toHaveBeenCalledTimes(6);
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
    const r = await findReportCandidates(withRaw({ building, property }), clues, { scopeWhere, canAccess: (q) => q.createdBy === "me" });
    // ⚠件数で切る前に DB の条件として効いている(@codex PR#500 2巡目)
    const where = (property.findMany.mock.calls[0] as unknown as [{ where: { AND: unknown[] } }])[0].where;
    expect(where.AND).toContainEqual(scopeWhere);
    expect(r.map((c) => c.propertyId)).toEqual(["mine"]);
  });

  it("手がかりが無ければ DB を引かない", async () => {
    const building = { findMany: vi.fn() };
    const property = { findMany: vi.fn() };
    expect(await findReportCandidates(withRaw({ building, property }), { buildingName: null, roomNo: null, address: null }, { scopeWhere: {}, canAccess: () => true })).toEqual([]);
    expect(property.findMany).not.toHaveBeenCalled();
  });
});

describe("searchPropertiesForReport(手で探す)", () => {
  it("★空白で区切った語をすべて含む物件。部屋番号でも絞れる(半角・全角・号/号室・空白入りも「含む」で拾う)", async () => {
    const property = { findMany: vi.fn(async () => []) };
    await searchPropertiesForReport({ property }, "東急ドエル　３０２号室", {});
    const where = (property.findMany.mock.calls[0] as unknown as [{ where: { AND: unknown[] } }])[0].where;
    expect(where.AND).toEqual([
      { isArchived: false },
      {
        OR: [
          { address: { contains: "東急ドエル", mode: "insensitive" } },
          { buildingName: { contains: "東急ドエル", mode: "insensitive" } },
          { roomNo: { contains: "東急ドエル" } },
          { roomNo: { contains: "東急ドエル" } },
        ],
      },
      {
        OR: [
          { address: { contains: "302号室", mode: "insensitive" } },
          { buildingName: { contains: "302号室", mode: "insensitive" } },
          { roomNo: { contains: "302" } },
          { roomNo: { contains: "３０２" } },
        ],
      },
      {},
    ]);
  });

  it("2文字未満は探さない", async () => {
    const property = { findMany: vi.fn() };
    expect(await searchPropertiesForReport({ property }, " a ", {})).toEqual([]);
    expect(property.findMany).not.toHaveBeenCalled();
  });
});
