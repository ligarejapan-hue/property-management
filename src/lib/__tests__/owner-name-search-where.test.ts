/**
 * 所有者を氏名で引く条件(2026-10-15 先頭1文字 → 氏名の全文字)。
 * ⚠条件を**生の格納値に実際に当てて**確かめる(素通しのモックでは、引き方を壊しても緑になる)。
 * 本番実測: 所有者14,850人・先頭「小」573/「山」432…で、先頭1文字の条件は take(200)に
 * 達して「確認しきれません」になっていた。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
const mockLinks = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { propertyOwner: { findMany: (...a: unknown[]) => mockLinks(...a) } },
}));
let mockDisplay = { name: "full", address: "full" };
vi.mock("@/lib/api-helpers", () => ({
  getOwnerDisplayConfig: vi.fn(async () => mockDisplay),
}));
const S = { id: "user-1", role: "admin" };
const P = [{ resource: "owner", action: "read", granted: true }];

import { ownerNameSearchWhere, findEarlierExcelImport } from "../paste-import-duplicates";
import { normalizeName } from "../normalize";

type Cond =
  | { name: { contains: string } }
  | { OR: Cond[] }
  | { AND: Cond[] };

function matches(cond: Cond, name: string): boolean {
  if ("AND" in cond) return cond.AND.every((c) => matches(c, name));
  if ("OR" in cond) return cond.OR.some((c) => matches(c, name));
  return name.includes(cond.name.contains);
}

/** DB の氏名の一覧に条件を当てて、返ってくる氏名を返す。 */
function search(pasted: string, dbNames: string[]): string[] {
  const where = ownerNameSearchWhere(pasted.trim(), normalizeName(pasted.trim()));
  expect(where.isArchived).toBe(false);
  const cond: Record<string, unknown> = { ...where };
  delete cond.isArchived;
  return dbNames.filter((n) => matches(cond as Cond, n));
}

describe("ownerNameSearchWhere", () => {
  it("★同じ先頭文字の別人は引かない(先頭1文字で何百人も返さない)", () => {
    const db = ["田中　晴美", "田中太郎", "田村晴子", "小林美晴", "田中　晴"];
    expect(search("田中　晴美", db)).toEqual(["田中　晴美"]);
  });

  it("★空白の位置・全角/半角空白の違いに左右されない", () => {
    expect(search("田中晴美", ["田中　晴美", "田中 晴美", "田中晴美"])).toHaveLength(3);
    expect(search("田中　晴美", ["田中晴美"])).toEqual(["田中晴美"]);
  });

  it("★全角/半角の英数・カナの違いでも本人を落とさない", () => {
    expect(search("ABC商事", ["ＡＢＣ商事"])).toEqual(["ＡＢＣ商事"]);
    expect(search("ＡＢＣ商事", ["ABC商事"])).toEqual(["ABC商事"]);
    expect(search("ﾀﾅｶ商店", ["タナカ商店"])).toEqual(["タナカ商店"]);
    expect(search("タナカ商店", ["ﾀﾅｶ商店"])).toEqual(["ﾀﾅｶ商店"]);
  });

  it("★濁点のある半角カナ(「ｶﾞ」=2文字)・結合濁点で保存された名前も落とさない", () => {
    expect(search("ガス商会", ["ｶﾞｽ商会"])).toEqual(["ｶﾞｽ商会"]);
    expect(search("パン工房", ["ﾊﾟﾝ工房"])).toEqual(["ﾊﾟﾝ工房"]);
    expect(search("ガス商会", ["ガス商会"])).toEqual(["ガス商会"]);
  });

  it("★互換漢字(登記の外字に混じる)で保存された名前も落とさない", () => {
    const compat = "神"; // 神(互換) → NFKC で 神(U+795E)
    expect(compat.normalize("NFKC")).toBe("神");
    expect(search("神田一郎", [`${compat}田一郎`])).toEqual([`${compat}田一郎`]);
  });

  it("★丸数字・ローマ数字・囲み文字で保存された名前も落とさない", () => {
    expect(search("第1ビル", ["第①ビル"])).toEqual(["第①ビル"]);
    expect(search("I商事", ["Ⅰ商事"])).toEqual(["Ⅰ商事"]);
    // 何文字にも展開される記号(@codex PR#516 P2)
    expect(search("第III商事", ["第Ⅲ商事"])).toEqual(["第Ⅲ商事"]);
    expect(search("第Ⅲ商事", ["第III商事"])).toEqual(["第III商事"]);
    expect(search("10番館", ["⑩番館"])).toEqual(["⑩番館"]);
    expect(search("平成商事", ["㍻商事"])).toEqual(["㍻商事"]);
    expect(search("上田", ["㊤田"])).toEqual(["㊤田"]);
  });

  it("★サロゲートペアの漢字(𠮷)を割らない", () => {
    expect(search("𠮷田太郎", ["𠮷田太郎", "吉田太郎"])).toEqual(["𠮷田太郎"]);
  });

  it("★法人の言葉・㈱の書き方の違いでも本人を落とさない(場所が前でも後でも)", () => {
    expect(search("株式会社田中工務店", ["株式会社田中工務店", "㍿田中工務店"])).toHaveLength(2);
    expect(search("田中工務店株式会社", ["田中工務店㍿"])).toEqual(["田中工務店㍿"]);
    expect(search("（株）伊藤不動産", ["㈱伊藤不動産", "(株)伊藤不動産"])).toHaveLength(2);
    expect(search("伊藤不動産㈱", ["伊藤不動産（株）"])).toEqual(["伊藤不動産（株）"]);
  });

  it("★取り出した候補には、正規化して同じ名前の人がすべて入っている(取りこぼしなし)", () => {
    const pairs: [string, string][] = [
      ["佐藤　花子", "佐藤花子"],
      ["ＡＢＣ　商事", "ABC商事"],
      ["ﾀﾞｲｺｸ屋", "ダイコク屋"],
      ["㈱山田", "(株)山田"],
      ["\uF91F田", "蘭田"], // 互換漢字 → NFKC で同じ字
    ];
    for (const [dbName, pasted] of pairs) {
      expect(normalizeName(dbName), dbName).toBe(normalizeName(pasted));
      expect(search(pasted, [dbName]), `${pasted} → ${dbName}`).toEqual([dbName]);
    }
  });

  it("★とても長い名前でも、条件は上限(8文字ぶん)で止まる・本人は落とさない(@codex PR#516 4巡目)", () => {
    const long = "山田太郎" + "あいうえおかきくけこさしすせそ".repeat(2000) + "1234567890ABCDEFG";
    const where = ownerNameSearchWhere(long, normalizeName(long)) as { AND?: { OR: unknown[] }[] };
    expect(where.AND?.length).toBe(8);
    const params = (where.AND ?? []).reduce((n, a) => n + a.OR.length, 0);
    expect(params).toBeLessThan(100);
    // 漢字(書き方が少ない)を優先して使う
    expect(search(long, [long, "山田花子"])).toEqual([long]);
  });

  it("文字が残らない異常値(法人の言葉だけ)は、空の条件を作らず先頭1文字で引く", () => {
    const where = ownerNameSearchWhere("株式会社", normalizeName("株式会社")) as {
      OR?: { name: { contains: string } }[];
    };
    const seeds = (where.OR ?? []).map((o) => o.name.contains);
    expect(seeds.length).toBeGreaterThan(0);
    expect(seeds.every((s) => s.length > 0)).toBe(true);
  });
});

describe("findEarlierExcelImport", () => {
  beforeEach(() => {
    mockLinks.mockReset();
    mockDisplay = { name: "full", address: "full" };
  });

  it("★所有者を検索できない人(owner:read なし・氏名や住所が伏せ字)には DB を引かず空で返す(@codex PR#516 3巡目)", async () => {
    mockLinks.mockResolvedValue([{ propertyId: "p-1", property: { roomNo: null }, owner: { name: "山田太郎" } }]);
    const input = { similarPropertyIds: ["p-1"], ownerName: "山田太郎", roomNo: null };
    expect(await findEarlierExcelImport(S, [], input)).toEqual([]);
    mockDisplay = { name: "partial", address: "full" };
    expect(await findEarlierExcelImport(S, P, input)).toEqual([]);
    mockDisplay = { name: "full", address: "partial" };
    expect(await findEarlierExcelImport(S, P, input)).toEqual([]);
    expect(mockLinks).not.toHaveBeenCalled();
  });

  it("★同じ住所の物件に、Excel取込の同じ氏名の所有者がいればその物件を返す", async () => {
    mockLinks.mockResolvedValue([{ propertyId: "p-1", property: { roomNo: null }, owner: { name: "山田太郎" } }]);
    expect(await findEarlierExcelImport(S, P, { similarPropertyIds: ["p-1"], ownerName: "山田　太郎", roomNo: null })).toEqual(["p-1"]);
    const args = mockLinks.mock.calls[0][0] as {
      where: { propertyId: { in: string[] }; owner: { isArchived: boolean; note: { startsWith: string } } };
    };
    expect(args.where.propertyId.in).toEqual(["p-1"]);
    expect(args.where.owner).toEqual({ isArchived: false, note: { startsWith: "Excel取込:" } });
  });

  it("★氏名が違えば(同じ住所に別の人を Excel で入れていても)返さない", async () => {
    mockLinks.mockResolvedValue([{ propertyId: "p-1", property: { roomNo: null }, owner: { name: "鈴木花子" } }]);
    expect(await findEarlierExcelImport(S, P, { similarPropertyIds: ["p-1"], ownerName: "山田太郎", roomNo: null })).toEqual([]);
  });

  it("★同じ人でも部屋番号が違えば(同じ建物の別の部屋)返さない・同じなら返す", async () => {
    mockLinks.mockResolvedValue([{ propertyId: "p-1", property: { roomNo: "502" }, owner: { name: "山田太郎" } }]);
    expect(await findEarlierExcelImport(S, P, { similarPropertyIds: ["p-1"], ownerName: "山田太郎", roomNo: "305" })).toEqual([]);
    expect(await findEarlierExcelImport(S, P, { similarPropertyIds: ["p-1"], ownerName: "山田太郎", roomNo: null })).toEqual([]);
    expect(await findEarlierExcelImport(S, P, { similarPropertyIds: ["p-1"], ownerName: "山田太郎", roomNo: "５０２" })).toEqual(["p-1"]);
  });

  it("★同じ人の物件が複数あれば全部返す(何行を登録済みにできるかは呼び出し側が決める)", async () => {
    mockLinks.mockResolvedValue([
      { propertyId: "p-2", property: { roomNo: null }, owner: { name: "山田太郎" } },
      { propertyId: "p-1", property: { roomNo: null }, owner: { name: "山田太郎" } },
      { propertyId: "p-1", property: { roomNo: null }, owner: { name: "山田太郎" } },
    ]);
    expect(await findEarlierExcelImport(S, P, { similarPropertyIds: ["p-1", "p-2"], ownerName: "山田太郎", roomNo: null }))
      .toEqual(["p-1", "p-2"]);
  });

  it("同じ住所の物件が無い・氏名が無いときは DB を引かない", async () => {
    expect(await findEarlierExcelImport(S, P, { similarPropertyIds: [], ownerName: "山田太郎", roomNo: null })).toEqual([]);
    expect(await findEarlierExcelImport(S, P, { similarPropertyIds: ["p-1"], ownerName: "  ", roomNo: null })).toEqual([]);
    expect(mockLinks).not.toHaveBeenCalled();
  });
});
