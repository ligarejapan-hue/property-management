import { describe, it, expect } from "vitest";
import {
  buildDedupeIndex,
  addToDedupeIndex,
  findPropertyDuplicate,
  findBuildingByNormalizedName,
  type PropertyRecord,
} from "../import-dedupe";

const P = (over: Partial<PropertyRecord> & { id: string; address: string }): PropertyRecord => ({
  roomNo: null,
  buildingId: null,
  realEstateNumber: null,
  externalLinkKey: null,
  ...over,
});

describe("buildDedupeIndex", () => {
  it("正規化住所で引けるインデックスを作る", () => {
    const idx = buildDedupeIndex([
      P({ id: "a", address: "東京都港区１－１－１" }),
      P({ id: "b", address: "東京都中央区2-2-2" }),
    ]);
    expect(idx.byNormalizedAddress.get("東京都港区1-1-1")?.id).toBe("a");
    expect(idx.byNormalizedAddress.get("東京都中央区2-2-2")?.id).toBe("b");
  });

  it("棟ごとにユニット配列を作る", () => {
    const idx = buildDedupeIndex([
      P({ id: "u1", address: "x", buildingId: "B1", roomNo: "101" }),
      P({ id: "u2", address: "x", buildingId: "B1", roomNo: "102" }),
      P({ id: "u3", address: "x", buildingId: "B2", roomNo: "101" }),
    ]);
    expect(idx.unitsByBuildingId.get("B1")?.length).toBe(2);
    expect(idx.unitsByBuildingId.get("B2")?.length).toBe(1);
  });

  it("既存重複は最初の1件を代表にする", () => {
    const idx = buildDedupeIndex([
      P({ id: "first", address: "東京都港区1-1-1" }),
      P({ id: "second", address: "東京都港区１－１－１" }),
    ]);
    expect(idx.byNormalizedAddress.get("東京都港区1-1-1")?.id).toBe("first");
  });
});

describe("findPropertyDuplicate - 住所表記ゆれ", () => {
  const existing = [
    P({ id: "a", address: "東京都千代田区1-1-1" }),
    P({ id: "b", address: "大阪市北区 2-2-2" }),
  ];
  const idx = buildDedupeIndex(existing);

  it("全角英数＋全角ダッシュ差異で一致する", () => {
    const hit = findPropertyDuplicate(
      idx,
      { address: "東京都千代田区１－１－１" },
      existing,
    );
    expect(hit?.matchedId).toBe("a");
    expect(hit?.reason).toBe("住所一致（正規化比較）");
  });

  it("前後空白差異で一致する", () => {
    const hit = findPropertyDuplicate(
      idx,
      { address: "  東京都千代田区1-1-1  " },
      existing,
    );
    expect(hit?.matchedId).toBe("a");
  });

  it("連続空白と en-dash で一致する", () => {
    const hit = findPropertyDuplicate(
      idx,
      { address: "大阪市北区\t\t2\u20132\u20132" },
      existing,
    );
    expect(hit?.matchedId).toBe("b");
  });

  it("一致しない住所は null", () => {
    const hit = findPropertyDuplicate(
      idx,
      { address: "福岡市博多区3-3-3" },
      existing,
    );
    expect(hit).toBeNull();
  });
});

describe("findPropertyDuplicate - 棟内 roomNo ゆれ", () => {
  const existing = [
    P({
      id: "u1",
      address: "東京都港区1-1-1 パークタワー",
      buildingId: "B1",
      roomNo: "101号室",
    }),
  ];
  const idx = buildDedupeIndex(existing);

  it("全角数字の部屋番号で一致する", () => {
    const hit = findPropertyDuplicate(
      idx,
      {
        address: "全く別の住所A",
        buildingId: "B1",
        roomNo: "１０１号室",
      },
      existing,
    );
    expect(hit?.matchedId).toBe("u1");
    expect(hit?.reason).toBe("棟内部屋番号一致（正規化比較）");
  });

  it("空白入り／全角差異で一致する", () => {
    const variants = ["101 号室", "１０１　号室", "101号室"];
    for (const v of variants) {
      const hit = findPropertyDuplicate(
        idx,
        { address: "全く別の住所B", buildingId: "B1", roomNo: v },
        existing,
      );
      expect(hit?.matchedId).toBe("u1");
    }
  });

  it("別棟の同じ部屋番号は衝突しない", () => {
    const hit = findPropertyDuplicate(
      idx,
      { address: "全く別の住所C", buildingId: "B2", roomNo: "101号室" },
      existing,
    );
    expect(hit).toBeNull();
  });
});

describe("findPropertyDuplicate - 識別子優先", () => {
  const existing = [
    P({
      id: "a",
      address: "東京都港区1-1-1",
      realEstateNumber: "RE-001",
      externalLinkKey: "LK-001",
    }),
  ];
  const idx = buildDedupeIndex(existing);

  it("realEstateNumber 一致を最優先で返す", () => {
    const hit = findPropertyDuplicate(
      idx,
      { address: "全然違う住所", realEstateNumber: "RE-001" },
      existing,
    );
    expect(hit?.reason).toBe("realEstateNumber一致");
  });

  it("externalLinkKey 一致を返す", () => {
    const hit = findPropertyDuplicate(
      idx,
      { address: "全然違う住所", externalLinkKey: "LK-001" },
      existing,
    );
    expect(hit?.reason).toBe("externalLinkKey一致");
  });
});

describe("addToDedupeIndex", () => {
  it("新規作成した物件を後続判定に反映する", () => {
    const existing: PropertyRecord[] = [];
    const idx = buildDedupeIndex(existing);
    addToDedupeIndex(idx, P({ id: "new", address: "東京都港区1-1-1" }));
    existing.push(P({ id: "new", address: "東京都港区1-1-1" }));

    const hit = findPropertyDuplicate(
      idx,
      { address: "東京都港区１－１－１" },
      existing,
    );
    expect(hit?.matchedId).toBe("new");
  });
});

describe("findBuildingByNormalizedName", () => {
  const pool = [
    { id: "b1", name: "パークタワー", address: "東京都港区1-1-1" },
    { id: "b2", name: "ABCマンション", address: "東京都渋谷区2-2-2" },
  ];

  it("全角半角・大小文字差異で1件に絞れる", () => {
    expect(findBuildingByNormalizedName(pool, "ＡＢＣマンション")?.id).toBe("b2");
    expect(findBuildingByNormalizedName(pool, "abc マンション")?.id).toBe("b2");
  });

  it("候補複数の場合は null を返す", () => {
    const duplicatedPool = [
      { id: "x", name: "A", address: "1" },
      { id: "y", name: "Ａ", address: "2" },
    ];
    expect(findBuildingByNormalizedName(duplicatedPool, "a")).toBeNull();
  });

  it("ヒットなしは null", () => {
    expect(findBuildingByNormalizedName(pool, "存在しない棟")).toBeNull();
  });
});
