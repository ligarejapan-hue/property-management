import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ default: { attachment: { findMany: vi.fn() }, property: { findUnique: vi.fn() } } }));
vi.mock("@/lib/storage", () => {
  const files = new Map<string, Buffer>();
  return {
    __files: files,
    getStorage: () => ({
      keyFromUrl: (u: string | null) => (u ? u.replace(/^\/uploads\//, "") : null),
      read: async (k: string) => (files.has(k) ? { body: files.get(k)! } : null),
    }),
  };
});
vi.mock("@/lib/pdf-extract", () => ({ extractTextFromPdf: vi.fn(async (b: Buffer) => b.toString("utf8")) }));
vi.mock("@/lib/registry-strike", async (orig) => ({
  ...(await orig<typeof import("@/lib/registry-strike")>()),
  summarizeRegistryRights: vi.fn(),
}));
const { parseRegistryText } = vi.hoisted(() => ({ parseRegistryText: vi.fn() }));
vi.mock("@/lib/pdf-registry-parser", () => ({ parseRegistryText }));

import prismaMock from "@/lib/prisma";
import * as storageMod from "@/lib/storage";
import { summarizeRegistryRights } from "@/lib/registry-strike";
import { loadCrosscheckRegistry } from "../crosscheck-load";
import { loadRegistryDocInfo } from "../registry-doc-info";

type Fn = ReturnType<typeof vi.fn>;
const findMany = (prismaMock as never as { attachment: { findMany: Fn } }).attachment.findMany;
const findProperty = (prismaMock as never as { property: { findUnique: Fn } }).property.findUnique;
const files = (storageMod as unknown as { __files: Map<string, Buffer> }).__files;
const FULL = "権 利 部 （ 甲 区 ） 権利部(乙区)";
const OWNER_TABLE = [
  "所有者事項", "┏━━━━━━━━━━┓", "┃ 所 有 者 ┃", "┠─────┬────┨", "┃ 住 所 │ 氏 名 ┃", "┠─────┼────┨",
  "┃架空県架空市1番1号 │架空太郎 ┃", "┗━━━━━┷━━━━┛", "", "-- 1 of 1 --",
].join("\n");
const SUMMARY = {
  hasKouku: true, ownersConfirmed: true, activeRights: [{ rank: "1" }, { rank: "2" }], cautions: [], notes: [],
  currentOwners: [{ name: "架空太郎", address: "架空県", share: "2分の1" }],
};
const att = (id: string, certType: string | null, at: string) => ({
  fileUrl: `/uploads/${id}.pdf`, registryCertificateType: certType, createdAt: new Date(at),
});
const opts = { kindBase: "unit" as const, includeOwners: true };

beforeEach(() => {
  vi.clearAllMocks();
  files.clear();
  findProperty.mockReset();
  findProperty.mockResolvedValue({ lotNumber: "1番", buildingNumber: "1番1", extraParcels: [] });
  (summarizeRegistryRights as Fn).mockResolvedValue(SUMMARY);
  parseRegistryText.mockReturnValue({ unitFloorArea: "60.25", landAreaRegistry: null, buildingFloorArea: null, owners: [] });
});

describe("照合に使う謄本の値を集める", () => {
  it("謄本が無ければ none", async () => {
    findMany.mockResolvedValue([]);
    expect(await loadCrosscheckRegistry("p", opts)).toEqual({ status: "none" });
  });
  it("全部事項から担保・所有者を読む(面積は読まない)", async () => {
    files.set("a.pdf", Buffer.from(FULL));
    findMany.mockResolvedValue([att("a", "all", "2026-10-01T00:00:00Z")]);
    const r = await loadCrosscheckRegistry("p", opts);
    expect(r).toMatchObject({
      status: "ok",
      rights: { activeRights: 2, readable: true },
      owners: { list: [{ name: "架空太郎", share: "2分の1" }], confirmed: true },
    });
    expect(r).not.toHaveProperty("areas");
  });
  it("所有者事項だけなら担保は無く、所有者の表を読む", async () => {
    files.set("b.pdf", Buffer.from(OWNER_TABLE));
    findMany.mockResolvedValue([att("b", "owner", "2026-10-02T00:00:00Z")]);
    const r = await loadCrosscheckRegistry("p", opts);
    expect(r).toMatchObject({ status: "ok", rights: null, owners: { confirmed: true, attachmentCreatedAt: "2026-10-02T00:00:00.000Z" } });
    if (r.status === "ok") expect(r.owners?.list[0].name).toBe("架空太郎");
  });
  it("所有者は新しい謄本から・担保は全部事項から", async () => {
    files.set("b.pdf", Buffer.from(OWNER_TABLE));
    files.set("a.pdf", Buffer.from(FULL));
    findMany.mockResolvedValue([att("b", "owner", "2026-10-02T00:00:00Z"), att("a", "all", "2026-09-01T00:00:00Z")]);
    const r = await loadCrosscheckRegistry("p", opts);
    if (r.status !== "ok") throw new Error("not ok");
    expect(r.owners?.attachmentCreatedAt).toBe("2026-10-02T00:00:00.000Z");
    expect(r.rights?.attachmentCreatedAt).toBe("2026-09-01T00:00:00.000Z");
  });
  it("所有者の表が読めない所有者事項は confirmed=false(古い謄本の名義で比べない)", async () => {
    files.set("b.pdf", Buffer.from("文字だけ"));
    files.set("a.pdf", Buffer.from(FULL));
    findMany.mockResolvedValue([att("b", "owner", "2026-10-02T00:00:00Z"), att("a", "all", "2026-09-01T00:00:00Z")]);
    const r = await loadCrosscheckRegistry("p", opts);
    if (r.status !== "ok") throw new Error("not ok");
    expect(r.owners).toMatchObject({ confirmed: false, list: [] });
  });
  it("全部事項と分かっている添付が読めない=担保は確認できない", async () => {
    findMany.mockResolvedValue([att("a", "all", "2026-10-01T00:00:00Z")]);
    const r = await loadCrosscheckRegistry("p", opts);
    expect(r).toMatchObject({ status: "ok", rights: { readable: false }, owners: { confirmed: false } });
  });
  it("種別が空で読めない添付だけ=unreadable", async () => {
    findMany.mockResolvedValue([att("a", null, "2026-10-01T00:00:00Z")]);
    expect(await loadCrosscheckRegistry("p", opts)).toEqual({ status: "unreadable" });
  });
  it("権限が無い人のときは氏名を持たない", async () => {
    files.set("a.pdf", Buffer.from(FULL));
    findMany.mockResolvedValue([att("a", "all", "2026-10-01T00:00:00Z")]);
    const r = await loadCrosscheckRegistry("p", { kindBase: "unit", includeOwners: false });
    expect(JSON.stringify(r)).not.toContain("架空太郎");
  });
});

describe("土地のある物件の謄本", () => {
  const LAND = (lot: string, area: string, no = `L${lot}`) => ({ realEstateNumber: no, address: "架空市", lotNumber: lot, buildingNumber: null, landAreaRegistry: area, buildingFloorArea: null, owners: [] });
  const BLDG = (no = "B1", area = "91.05") => ({ realEstateNumber: no, address: "架空市", lotNumber: null, buildingNumber: "1番1", landAreaRegistry: null, buildingFloorArea: area, owners: [] });
  const summary = (active: number, owners: { name: string; share: string | null }[] = [{ name: "架空太郎", share: null }], over = {}) => ({
    hasKouku: true, ownersConfirmed: true, activeRights: Array.from({ length: active }, (_, i) => ({ rank: String(i + 1) })), cautions: [], notes: [],
    currentOwners: owners.map((o) => ({ ...o, address: null })), ...over,
  });
  /** 添付を新しい順に並べ、順に読み取り結果を返す。 */
  const setup = (entries: [string, string | null, string, object | null, object?, string?][]) => {
    findMany.mockResolvedValue(entries.map(([id, cert, at]) => att(id, cert, at)));
    parseRegistryText.mockReset();
    (summarizeRegistryRights as Fn).mockReset();
    for (const [id, , , parsed, sum, text] of entries) {
      if (parsed === null) continue;
      files.set(`${id}.pdf`, Buffer.from(text ?? FULL));
      parseRegistryText.mockReturnValueOnce(parsed);
      if (sum) (summarizeRegistryRights as Fn).mockResolvedValueOnce(sum);
    }
  };
  const house = { kindBase: "house" as const, includeOwners: true };

  it("土地と建物の両方を読み、担保を合計し、日付は古いほう(面積は読まない)", async () => {
    setup([
      ["b", "all", "2026-10-02T00:00:00Z", BLDG(), summary(1)],
      ["l", "all", "2026-09-01T00:00:00Z", LAND("1番", "120.50"), summary(2)],
    ]);
    const r = await loadCrosscheckRegistry("p", house);
    expect(r).toMatchObject({
      status: "ok", missing: [], uncertain: null,
      rights: { activeRights: 3, readable: true, attachmentCreatedAt: "2026-09-01T00:00:00.000Z" },
      owners: { confirmed: true, attachmentCreatedAt: "2026-09-01T00:00:00.000Z", newestCreatedAt: "2026-10-02T00:00:00.000Z" },
      certificates: [{ side: "建物", createdAt: "2026-10-02T00:00:00.000Z" }, { side: "土地", createdAt: "2026-09-01T00:00:00.000Z" }],
    });
    expect(r).not.toHaveProperty("areas");
  });
  it("土地が複数筆なら全筆を読み、担保を合計する", async () => {
    setup([
      ["b", "all", "2026-10-03T00:00:00Z", BLDG(), summary(0)],
      ["l1", "all", "2026-10-02T00:00:00Z", LAND("1番", "100.25"), summary(1)],
      ["l2", "all", "2026-10-01T00:00:00Z", LAND("2番", "20.25"), summary(1)],
    ]);
    const r = await loadCrosscheckRegistry("p", house);
    expect(r).toMatchObject({ rights: { activeRights: 2 }, missing: [] });
  });
  it("同じ筆は最新の1通だけ(古い謄本の権利を足さない)", async () => {
    setup([
      ["b", "all", "2026-10-03T00:00:00Z", BLDG(), summary(0)],
      ["new", "all", "2026-10-02T00:00:00Z", LAND("1番", "120.50"), summary(0)],
      ["old", "all", "2026-01-01T00:00:00Z", LAND("1番", "120.50"), summary(5)],
    ]);
    const r = await loadCrosscheckRegistry("p", house);
    expect(r).toMatchObject({ rights: { activeRights: 0 } });
  });
  it("片方だけなら足りない側を返す", async () => {
    setup([["l", "all", "2026-10-01T00:00:00Z", LAND("1番", "120.50"), summary(1)]]);
    expect(await loadCrosscheckRegistry("p", house)).toMatchObject({ status: "ok", missing: ["建物"], rights: { activeRights: 1 } });
    setup([["b", "all", "2026-10-01T00:00:00Z", BLDG(), summary(0)]]);
    expect(await loadCrosscheckRegistry("p", house)).toMatchObject({ missing: ["土地"] });
  });
  it("土地の取引は建物の謄本を数えない・足りないとも言わない", async () => {
    setup([
      // 建物の謄本は権利を読まない(読み取り結果を用意しない)。
      ["b", "all", "2026-10-02T00:00:00Z", BLDG()],
      ["l", "all", "2026-10-01T00:00:00Z", LAND("1番", "120.50"), summary(1)],
    ]);
    expect(await loadCrosscheckRegistry("p", { kindBase: "land", includeOwners: false })).toMatchObject({ missing: [], rights: { activeRights: 1 } });
  });
  it("読めない謄本があれば uncertain(古くても。抜けた筆かもしれない)", async () => {
    setup([
      ["b", "all", "2026-10-03T00:00:00Z", BLDG(), summary(0)],
      ["l", "all", "2026-10-02T00:00:00Z", LAND("1番", "120.50"), summary(0)],
      ["x", null, "2026-01-01T00:00:00Z", null],
    ]);
    expect(await loadCrosscheckRegistry("p", house)).toMatchObject({ uncertain: "unreadable" });
  });
  it("土地の謄本の共同担保目録に家屋番号があっても土地として扱う", async () => {
    const landText = "表題部 土地の表示 ①地番 ②地目 ③地積\n権 利 部 （ 甲 区 ）\n共同担保目録 家屋番号 1番1";
    const buildingText = "表題部 主である建物の表示 家屋番号 1番1\n権 利 部 （ 甲 区 ）";
    setup([
      ["l", "all", "2026-10-02T00:00:00Z", { ...LAND("1番", "120.50"), buildingNumber: "1番1" }, summary(1), landText],
      ["b", "all", "2026-10-01T00:00:00Z", BLDG(), summary(1), buildingText],
    ]);
    expect(await loadCrosscheckRegistry("p", house)).toMatchObject({
      missing: [], uncertain: null, rights: { activeRights: 2 },
    });
  });
  it("不動産番号が無くても、土地と建物を取り違えず別の物件として数える", async () => {
    const landText = "表題部 土地の表示 ①地番 ②地目 ③地積\n権 利 部 （ 甲 区 ）\n共同担保目録 家屋番号 1番";
    const buildingText = "表題部 主である建物の表示 家屋番号 1番\n権 利 部 （ 甲 区 ）";
    setup([
      ["l", "all", "2026-10-02T00:00:00Z", { ...LAND("1番", "120.50"), realEstateNumber: null, buildingNumber: "1番" }, summary(1), landText],
      ["b", "all", "2026-10-01T00:00:00Z", { ...BLDG(), realEstateNumber: null, buildingNumber: "1番" }, summary(1), buildingText],
    ]);
    expect(await loadCrosscheckRegistry("p", house)).toMatchObject({ missing: [], rights: { activeRights: 2 } });
  });
  it("種別が空で全部事項とも所有者事項とも読めない謄本は読み飛ばさない", async () => {
    setup([
      ["l", "all", "2026-10-02T00:00:00Z", LAND("1番", "120.50"), summary(0)],
      ["s", null, "2026-01-01T00:00:00Z", { owners: [] }, undefined, "読み取りの崩れた文字"],
    ]);
    const r = await loadCrosscheckRegistry("p", { kindBase: "land", includeOwners: false });
    expect(r).toMatchObject({ uncertain: "unreadable" });
  });
  it("別々の不動産番号が入った1つの PDF は判定できない扱い", async () => {
    const text = "不動産番号 1234567890123\n地番 1番\n権利部(甲区)\n不動産番号 1234567890124\n地番 2番";
    setup([["l", "all", "2026-10-02T00:00:00Z", LAND("1番", "120.50"), undefined, text]]);
    expect(await loadCrosscheckRegistry("p", { kindBase: "land", includeOwners: false })).toMatchObject({ uncertain: "unclassified" });
  });
  it("書式の違いで全部事項と結びつかない新しい所有者事項も名義に足す", async () => {
    setup([
      ["o", "owner", "2026-10-05T00:00:00Z", { ...LAND("1番", "120.50"), realEstateNumber: null }, undefined, OWNER_TABLE],
      ["l", "all", "2026-10-01T00:00:00Z", LAND("1番", "120.50"), summary(0, [{ name: "古い名義", share: null }])],
    ]);
    const r = await loadCrosscheckRegistry("p", { kindBase: "land", includeOwners: true });
    if (r.status !== "ok") throw new Error("not ok");
    expect(r.owners?.list.map((o) => o.name).sort()).toEqual(["古い名義", "架空太郎"].sort());
  });
  it("土地と建物で異体字が違えば differsAcross(黙ってそろえない)", async () => {
    setup([
      ["b", "all", "2026-10-02T00:00:00Z", BLDG(), summary(0, [{ name: "高橋一郎", share: null }])],
      ["l", "all", "2026-10-01T00:00:00Z", LAND("1番", "120.50"), summary(0, [{ name: "髙橋一郎", share: null }])],
    ]);
    const r = await loadCrosscheckRegistry("p", house);
    if (r.status !== "ok") throw new Error("not ok");
    expect(r.owners?.differsAcross).toBe(true);
    expect(r.owners?.list).toHaveLength(1);
  });
  it("所有者事項しかない筆があれば uncertain(担保を見ていない)・権限が無い人でも同じ", async () => {
    const entries: Parameters<typeof setup>[0] = [
      ["o", "owner", "2026-10-05T00:00:00Z", LAND("2番", "1", "L2"), undefined, OWNER_TABLE],
      ["l", "all", "2026-10-01T00:00:00Z", LAND("1番", "120.50"), summary(0)],
    ];
    setup(entries);
    expect(await loadCrosscheckRegistry("p", { kindBase: "land", includeOwners: true })).toMatchObject({ uncertain: "no_full_certificate", missing: [] });
    setup(entries);
    expect(await loadCrosscheckRegistry("p", { kindBase: "land", includeOwners: false })).toMatchObject({ uncertain: "no_full_certificate" });
    setup(entries);
    expect(await loadRegistryDocInfo("p", "land")).toEqual({ activeRights: 0, caution: "謄本を確認してください(全部事項の謄本が無い土地・建物があります)" });
  });
  it("要らない種類の所有者事項は名義に足さない(土地の取引の建物)", async () => {
    setup([
      ["x", "owner", "2026-10-05T00:00:00Z", BLDG(), undefined, OWNER_TABLE],
      ["l", "all", "2026-10-01T00:00:00Z", LAND("1番", "120.50"), summary(0, [{ name: "土地の名義", share: null }])],
    ]);
    const r = await loadCrosscheckRegistry("p", { kindBase: "land", includeOwners: true });
    if (r.status !== "ok") throw new Error("not ok");
    expect(r.owners?.list.map((o) => o.name)).toEqual(["土地の名義"]);
    expect(r.owners?.newestCreatedAt).toBe("2026-10-01T00:00:00.000Z");
  });
  it("読めない所有者事項は、権限の有無によらず uncertain", async () => {
    for (const includeOwners of [true, false]) {
      setup([
        ["l", "all", "2026-10-02T00:00:00Z", LAND("1番", "120.50"), summary(0)],
        ["o", "owner", "2026-01-01T00:00:00Z", null],
      ]);
      expect(await loadCrosscheckRegistry("p", { kindBase: "land", includeOwners })).toMatchObject({ uncertain: "unreadable" });
    }
  });
  it("複数の不動産番号が入った所有者事項は、権限の有無によらず uncertain", async () => {
    const text = `不動産番号 1234567890123\n不動産番号 1234567890124\n${OWNER_TABLE}`;
    for (const includeOwners of [true, false]) {
      setup([
        ["o", "owner", "2026-10-05T00:00:00Z", LAND("1番", "120.50"), undefined, text],
        ["l", "all", "2026-10-01T00:00:00Z", LAND("1番", "120.50"), summary(0)],
      ]);
      expect(await loadCrosscheckRegistry("p", { kindBase: "land", includeOwners })).toMatchObject({ uncertain: "unclassified" });
    }
  });
  it("読めるのに物件を特定できない所有者事項では止めない", async () => {
    setup([
      ["o", "owner", "2026-01-01T00:00:00Z", { realEstateNumber: null, address: null, lotNumber: null, buildingNumber: null, owners: [] }, undefined, OWNER_TABLE],
      ["l", "all", "2026-10-01T00:00:00Z", LAND("1番", "120.50"), summary(0)],
    ]);
    expect(await loadCrosscheckRegistry("p", { kindBase: "land", includeOwners: false })).toMatchObject({ uncertain: null });
  });
  it("全部事項がある筆の所有者事項・要らない種類の所有者事項では uncertain にしない", async () => {
    setup([
      ["o", "owner", "2026-10-05T00:00:00Z", LAND("1番", "120.50"), undefined, OWNER_TABLE],
      ["x", "owner", "2026-10-04T00:00:00Z", BLDG(), undefined, OWNER_TABLE],
      ["l", "all", "2026-10-01T00:00:00Z", LAND("1番", "120.50"), summary(0)],
    ]);
    expect(await loadCrosscheckRegistry("p", { kindBase: "land", includeOwners: false })).toMatchObject({ uncertain: null });
  });
  it("土地か建物か判定できない全部事項があれば uncertain", async () => {
    setup([["u", "all", "2026-10-02T00:00:00Z", { realEstateNumber: null, address: null, lotNumber: null, buildingNumber: null, owners: [] }]]);
    expect(await loadCrosscheckRegistry("p", house)).toMatchObject({ uncertain: "unclassified", missing: ["土地", "建物"] });
  });
  it("上限を超える添付があれば uncertain", async () => {
    findMany.mockResolvedValue(Array.from({ length: 21 }, (_, n) => att(`z${n}`, "owner", "2026-10-01T00:00:00Z")));
    files.set("z0.pdf", Buffer.from(OWNER_TABLE));
    expect(await loadCrosscheckRegistry("p", house)).toMatchObject({ uncertain: "too_many" });
    expect(findMany.mock.calls[0][0].take).toBe(21);
  });
  it("所有者は全部の謄本から集める・土地と建物で違えば differsAcross", async () => {
    setup([
      ["b", "all", "2026-10-02T00:00:00Z", BLDG(), summary(0, [{ name: "架空太郎", share: null }])],
      ["l", "all", "2026-10-01T00:00:00Z", LAND("1番", "120.50"), summary(0, [{ name: "架空太郎", share: "2分の1" }, { name: "架空花子", share: "2分の1" }])],
    ]);
    const r = await loadCrosscheckRegistry("p", house);
    if (r.status !== "ok") throw new Error("not ok");
    expect(r.owners?.list.map((o) => o.name).sort()).toEqual(["架空太郎", "架空花子"].sort());
    expect(r.owners?.differsAcross).toBe(true);
  });
  it("所有者が同じなら differsAcross にならない・持分も残す", async () => {
    const same = [{ name: "架空太郎", share: "2分の1" }, { name: "架空花子", share: "２分の１" }];
    setup([
      ["b", "all", "2026-10-02T00:00:00Z", BLDG(), summary(0, same)],
      ["l", "all", "2026-10-01T00:00:00Z", LAND("1番", "120.50"), summary(0, [same[1], same[0]])],
    ]);
    const r = await loadCrosscheckRegistry("p", house);
    if (r.status !== "ok") throw new Error("not ok");
    expect(r.owners?.differsAcross).toBe(false);
    expect(r.owners?.list).toHaveLength(2);
  });
  it("注記のある謄本が1通でもあれば confirmed=false・乙区が読めなければ readable=false", async () => {
    setup([
      ["b", "all", "2026-10-02T00:00:00Z", BLDG(), summary(1, undefined, { ownersConfirmed: false })],
      ["l", "all", "2026-10-01T00:00:00Z", LAND("1番", "120.50"), summary(0, undefined, { hasKouku: false })],
    ]);
    expect(await loadCrosscheckRegistry("p", house)).toMatchObject({ owners: { confirmed: false }, rights: { readable: false, activeRights: 1 } });
  });
  it("同じ物件のより新しい所有者事項があれば、その名義を使う", async () => {
    setup([
      ["o", "owner", "2026-10-05T00:00:00Z", LAND("1番", "120.50"), undefined, OWNER_TABLE],
      ["b", "all", "2026-10-02T00:00:00Z", BLDG(), summary(0, [{ name: "架空太郎", share: null }])],
      ["l", "all", "2026-10-01T00:00:00Z", LAND("1番", "120.50"), summary(0, [{ name: "古い名義", share: null }])],
    ]);
    const r = await loadCrosscheckRegistry("p", house);
    if (r.status !== "ok") throw new Error("not ok");
    expect(r.owners?.list.map((o) => o.name)).toEqual(["架空太郎"]);
    expect(r.owners?.newestCreatedAt).toBe("2026-10-05T00:00:00.000Z");
  });
  it("どの物件か分からない新しい所有者事項は名義に足す(黙って捨てない)", async () => {
    setup([
      ["o", "owner", "2026-10-05T00:00:00Z", { realEstateNumber: null, address: null, lotNumber: null, buildingNumber: null, owners: [] }, undefined, OWNER_TABLE],
      ["b", "all", "2026-10-02T00:00:00Z", BLDG(), summary(0, [{ name: "別の名義", share: null }])],
      ["l", "all", "2026-10-01T00:00:00Z", LAND("1番", "120.50"), summary(0, [{ name: "別の名義", share: null }])],
    ]);
    const r = await loadCrosscheckRegistry("p", house);
    if (r.status !== "ok") throw new Error("not ok");
    expect(r.owners?.list.map((o) => o.name).sort()).toEqual(["別の名義", "架空太郎"].sort());
  });
  it("権限が無い人のときは氏名を持たない", async () => {
    setup([
      ["b", "all", "2026-10-02T00:00:00Z", BLDG(), summary(0)],
      ["l", "all", "2026-10-01T00:00:00Z", LAND("1番", "120.50"), summary(0)],
    ]);
    const r = await loadCrosscheckRegistry("p", { kindBase: "house", includeOwners: false });
    expect(JSON.stringify(r)).not.toContain("架空太郎");
  });
  it("添付が無ければ none・読める謄本が無ければ unreadable", async () => {
    findMany.mockResolvedValue([]);
    expect(await loadCrosscheckRegistry("p", house)).toEqual({ status: "none" });
    setup([["x", null, "2026-01-01T00:00:00Z", null]]);
    expect(await loadCrosscheckRegistry("p", house)).toEqual({ status: "unreadable" });
  });
  it("書類確認書の件数も土地と建物の合計・足りなければ注意を添える", async () => {
    setup([
      ["b", "all", "2026-10-02T00:00:00Z", BLDG(), summary(1)],
      ["l", "all", "2026-10-01T00:00:00Z", LAND("1番", "120.50"), summary(2)],
    ]);
    expect(await loadRegistryDocInfo("p", "house")).toEqual({ activeRights: 3, caution: null });
    setup([["l", "all", "2026-10-01T00:00:00Z", LAND("1番", "120.50"), summary(2)]]);
    expect(await loadRegistryDocInfo("p", "house")).toEqual({ activeRights: 2, caution: "謄本を確認してください(建物の謄本がありません)" });
    findMany.mockResolvedValue([]);
    expect(await loadRegistryDocInfo("p", "house")).toEqual({ activeRights: 0, caution: null });
  });

  describe("2筆以上・2棟以上の物件(ほかの土地・建物を足した物件)", () => {
    const extra = (id: string, kind: "land" | "building", number: string, realEstateNumber: string | null = null, location: string | null = null) => (
      { id, kind, location, number, realEstateNumber, area: null }
    );
    /** 表題部の表つきの全部事項(番号は表の欄から読む=registryIdentityOf)。 */
    const landTx = (lot: string) => [
      "┃ 表 題 部 （土地の表示） ┃", "┃① 地 番 │② 地 目 │③ 地 積 ㎡ │ 原因 ┃", `┃${lot} │宅地 │１００：００│ ┃`, FULL,
    ].join("\n");
    const bldgTx = (no: string) => ["┃ 表 題 部 （主である建物の表示） ┃", `┃家屋番号 │${no} │ ┃`, FULL].join("\n");

    it("足した筆の謄本が無ければ、その筆を missingParcels に出す", async () => {
      findProperty.mockResolvedValue({ lotNumber: "1番", buildingNumber: "1番1", extraParcels: [extra("x", "land", "2番")] });
      const entries: Parameters<typeof setup>[0] = [
        ["b", "all", "2026-10-02T00:00:00Z", BLDG(), summary(0), bldgTx("１番１")],
        ["l", "all", "2026-10-01T00:00:00Z", LAND("1番", "120.50"), summary(0), landTx("１番")],
      ];
      setup(entries);
      expect(await loadCrosscheckRegistry("p", house)).toMatchObject({ missing: [], missingParcels: ["土地 2番"], uncertain: null });
      setup(entries);
      expect(await loadRegistryDocInfo("p", "house")).toEqual({ activeRights: 0, caution: "謄本を確認してください(土地 2番の謄本がありません)" });
    });
    it("1筆目の謄本が無いことも分かる(2筆目の謄本だけで土地を足りた扱いにしない)", async () => {
      findProperty.mockResolvedValue({ lotNumber: "1番", buildingNumber: "1番1", extraParcels: [extra("x", "land", "２番")] });
      setup([
        ["b", "all", "2026-10-02T00:00:00Z", BLDG(), summary(0), bldgTx("１番１")],
        ["l", "all", "2026-10-01T00:00:00Z", LAND("2番", "20.25"), summary(0), landTx("２番")],
      ]);
      expect(await loadCrosscheckRegistry("p", house)).toMatchObject({ missing: [], missingParcels: ["土地 1番"] });
    });
    it("★「1番1の2」を「1番1」と取り違えない(番号は表の欄全体から・@codex P2)", async () => {
      findProperty.mockResolvedValue({ lotNumber: "1番1", buildingNumber: null, extraParcels: [extra("x", "land", "1番1の2")] });
      // 全文から拾う読み取りは「1番1」に切る。
      setup([["l2", "all", "2026-10-02T00:00:00Z", LAND("1番1", "20.25", "L2"), summary(0), landTx("１番１の２")]]);
      expect(await loadCrosscheckRegistry("p", { kindBase: "land", includeOwners: true })).toMatchObject({ missingParcels: ["土地 1番1"] });
    });
    it("全部そろえば missingParcels は出さない・不動産番号が両方にあれば不動産番号で比べる", async () => {
      findProperty.mockResolvedValue({ lotNumber: "1番", buildingNumber: "1番1", extraParcels: [extra("x", "land", "別の書き方", "L2"), extra("y", "building", "1番2", "B2")] });
      setup([
        ["b2", "all", "2026-10-04T00:00:00Z", BLDG("B2"), summary(0), bldgTx("１番２")],
        ["b", "all", "2026-10-03T00:00:00Z", BLDG(), summary(0), bldgTx("１番１")],
        ["l2", "all", "2026-10-02T00:00:00Z", LAND("2番", "20.25", "L2"), summary(0), landTx("２番")],
        ["l", "all", "2026-10-01T00:00:00Z", LAND("1番", "120.50"), summary(0), landTx("１番")],
      ]);
      const r = await loadCrosscheckRegistry("p", house);
      expect(r).toMatchObject({ missing: [], uncertain: null });
      expect(r).not.toHaveProperty("missingParcels");
    });
    it("★所在が違う同じ番号の筆は、1通で両方を満たしたことにしない(@codex P1)", async () => {
      findProperty.mockResolvedValue({ lotNumber: "1番", buildingNumber: null, extraParcels: [extra("x", "land", "1番", null, "架空町二丁目")] });
      setup([["l", "all", "2026-10-01T00:00:00Z", { ...LAND("1番", "120.50"), address: "架空市架空町一丁目" }, summary(0), landTx("１番")]]);
      expect(await loadCrosscheckRegistry("p", { kindBase: "land", includeOwners: true })).toMatchObject({ missingParcels: ["土地 架空町二丁目 1番"] });
    });
    it("土地の取引では建物の行を見ない", async () => {
      findProperty.mockResolvedValue({ lotNumber: "1番", buildingNumber: null, extraParcels: [extra("y", "building", "1番2")] });
      setup([["l", "all", "2026-10-01T00:00:00Z", LAND("1番", "120.50"), summary(0), landTx("１番")]]);
      const r = await loadCrosscheckRegistry("p", { kindBase: "land", includeOwners: true });
      expect(r).not.toHaveProperty("missingParcels");
    });
    it("番号を読めずどの筆か分からない全部事項があれば uncertain", async () => {
      findProperty.mockResolvedValue({ lotNumber: "1番", buildingNumber: null, extraParcels: [extra("x", "land", "2番")] });
      setup([
        ["u", "all", "2026-10-02T00:00:00Z", LAND("1番", "1", "LX"), summary(0), landTx("１番 ２")],
        ["l", "all", "2026-10-01T00:00:00Z", LAND("1番", "120.50"), summary(0), landTx("１番")],
      ]);
      expect(await loadCrosscheckRegistry("p", { kindBase: "land", includeOwners: true })).toMatchObject({ uncertain: "unplaced_parcel", missingParcels: ["土地 2番"] });
    });
    it("足していない物件は今までどおり(筆ごとには見ない)", async () => {
      findProperty.mockResolvedValue({ lotNumber: "9番", buildingNumber: "9番1", extraParcels: [] });
      setup([
        ["b", "all", "2026-10-02T00:00:00Z", BLDG(), summary(0)],
        ["l", "all", "2026-10-01T00:00:00Z", LAND("1番", "120.50"), summary(0)],
      ]);
      const r = await loadCrosscheckRegistry("p", house);
      expect(r).toMatchObject({ missing: [], uncertain: null });
      expect(r).not.toHaveProperty("missingParcels");
    });
  });
});
