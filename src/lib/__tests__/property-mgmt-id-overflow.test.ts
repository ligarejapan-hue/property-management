import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { readFileSync } from "fs";

// 管理ID の一致が上限を超えたときの扱い (@codex #330 R2)。
//
// 「上限+1 件返して CSV の行数ガードに当てる」方式は成立しない。CSV の where は
// 管理ID に加えて案件状況・DM状況・日付・field_staff スコープを **AND** するため、
// 切り捨てた id 側にだけ条件を満たす行があると最終行数は上限未満に収まり、
// 行数ガードが発火しないまま**取りこぼした CSV / DM差込 CSV** が出てしまう。
// 超過は行数ではなく overflowed フラグで運び、出力経路は必ずそこで止める。

const mgmtMatches = vi.fn();
vi.mock("@/lib/property-mgmt-id-search", () => ({
  resolveMgmtIdMatches: (...args: unknown[]) => mgmtMatches(...args),
}));

import { buildPropertyListWhere } from "@/lib/property-list-query";
import { propertyListQuerySchema } from "@/lib/validators";

const session = { id: "u1", role: "admin" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildPropertyListWhere: 管理ID の上限超過を呼び出し側へ伝える", () => {
  it("超過時は mgmtOverflowed=true を返す", async () => {
    (mgmtMatches as Mock).mockResolvedValue({
      ids: ["a", "b"],
      overflowed: true,
    });
    const q = propertyListQuerySchema.parse({ mgmtId: "受付帳.xlsx" });
    const res = await buildPropertyListWhere(q, session);
    expect(res.mgmtOverflowed).toBe(true);
    // 切り捨て済みの id はそのまま where に入る(一覧は従来どおり表示できる)。
    expect(res.where.AND).toEqual([{ id: { in: ["a", "b"] } }]);
  });

  it("超過していなければ false", async () => {
    (mgmtMatches as Mock).mockResolvedValue({ ids: ["a"], overflowed: false });
    const q = propertyListQuerySchema.parse({ mgmtId: "受付帳.xlsx" });
    expect((await buildPropertyListWhere(q, session)).mgmtOverflowed).toBe(
      false,
    );
  });

  it("管理ID 未指定なら解決自体を行わず false", async () => {
    const q = propertyListQuerySchema.parse({});
    const res = await buildPropertyListWhere(q, session);
    expect(mgmtMatches).not.toHaveBeenCalled();
    expect(res.mgmtOverflowed).toBe(false);
  });

  it("他の絞り込みと併用しても超過フラグは消えない (この事故の本体)", async () => {
    // 案件状況で絞ると最終行数は上限未満に収まり得る。行数ガードだけでは
    // 「取りこぼした CSV」を止められないことを、条件併用の形で固定する。
    (mgmtMatches as Mock).mockResolvedValue({ ids: ["a"], overflowed: true });
    const q = propertyListQuerySchema.parse({
      mgmtId: "受付帳.xlsx",
      caseStatus: "new_case",
    });
    const res = await buildPropertyListWhere(q, session);
    expect(res.where.caseStatus).toBe("new_case");
    expect(res.mgmtOverflowed).toBe(true);
  });
});

describe("CSV 出力経路は overflowed で必ず止める", () => {
  // route 本体は DB/認証に密結合なのでソース表明で固定する
  // (vitest は env=node で Next の route を素直に起動できない)。
  const ROUTES = [
    "src/app/api/properties/export/route.ts",
    "src/app/api/properties/dm-batches/route.ts",
    "src/app/api/properties/property-dm-export/route.ts",
    // 有料の AI 文面生成。並べ替えたうえで先頭 50 件を選ぶため、母集団が
    // 「取込行の並び順で先頭 10,000 件」に化けると**本来選ばれない宛先に
    // 課金して文面を作る** (@codex #330 R3)。
    "src/app/api/properties/sale-dm/campaigns/route.ts",
  ];

  it.each(ROUTES)("%s は mgmtOverflowed を受け取り 400 で中止する", (path) => {
    const src = readFileSync(path, "utf8");
    expect(src).toMatch(/mgmtOverflowed/);
    expect(src).toMatch(
      /if \(mgmtOverflowed\) \{[\s\S]*?(EXPORT_LIMIT_EXCEEDED|MGMT_ID_LIMIT_EXCEEDED)/,
    );
  });

  it.each(ROUTES)("%s の中止は物件行を取得する前に行う", (path) => {
    const src = readFileSync(path, "utf8");
    // 取りこぼした行を作ってから判定しても意味がない (出力直前で気づけない)。
    expect(src.indexOf("if (mgmtOverflowed)")).toBeGreaterThan(-1);
    expect(src.indexOf("if (mgmtOverflowed)")).toBeLessThan(
      src.indexOf("prisma.property.findMany"),
    );
  });
});
