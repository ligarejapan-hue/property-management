import { describe, it, expect } from "vitest";
import {
  parseReceptionRows,
  parseOwnerRows,
  matchReceptionToOwners,
  matchPropertyByReception,
  buildCombinedMatches,
  summarizeMatches,
  getReviewReason,
  type ParsedReceptionRow,
  type ParsedOwnerRow,
  type PropertyCandidate,
  type CombinedMatch,
} from "../reception-owner-match";

// ---------- parseReceptionRows ----------

describe("parseReceptionRows", () => {
  it("H/I/J/K 位置から matchKey を組み立てる", () => {
    const rows = [
      [
        "A", "B", "C", "D", "E",
        "土地",     // F(5)
        "G",
        "東京都",   // H(7)
        "港区",     // I(8)
        "1-2-3",    // J(9)
        "100",      // K(10)
      ],
    ];
    const parsed = parseReceptionRows(rows);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].matchKey).toBe("東京都港区1-2-3100");
    expect(parsed[0].rowNumber).toBe(2);
    expect(parsed[0].fColumn).toBe("土地");
    expect(parsed[0].kColumn).toBe("100");
    expect(parsed[0].lotNumber).toBe("100");
    expect(parsed[0].buildingNumber).toBeNull();
  });

  it("F=建物 → K は buildingNumber に振り分け", () => {
    const rows = [
      ["", "", "", "", "", "建物", "", "東京都", "港区", "1-2-3", "A-101"],
    ];
    const [row] = parseReceptionRows(rows);
    expect(row.lotNumber).toBeNull();
    expect(row.buildingNumber).toBe("A-101");
  });

  it("F が ambiguous なら lot/building 両方 null", () => {
    const rows = [
      ["", "", "", "", "", "未定", "", "東京都", "港区", "1-2-3", "100"],
    ];
    const [row] = parseReceptionRows(rows);
    expect(row.lotNumber).toBeNull();
    expect(row.buildingNumber).toBeNull();
    expect(row.matchKey).toBe("東京都港区1-2-3100");
  });

  it("全角英数・ハイフン・空白を含んでも正規化で揃う", () => {
    const rows = [
      ["", "", "", "", "", "土地", "", "東京都", "港区", "１－２－３", "１００"],
    ];
    const [row] = parseReceptionRows(rows);
    expect(row.matchKey).toBe("東京都港区1-2-3100");
  });

  it("足りない列は空扱い", () => {
    const rows = [["only", "two"]];
    const [row] = parseReceptionRows(rows);
    expect(row.matchKey).toBe("");
    expect(row.lotNumber).toBeNull();
    expect(row.buildingNumber).toBeNull();
  });

  it("propertyAddress = H+I+J 連結（K は含まない）", () => {
    const rows = [
      ["", "", "", "", "", "土地", "", "東京都", "港区", "六本木1-2-3", "100番1", ""],
    ];
    const [row] = parseReceptionRows(rows);
    expect(row.propertyAddress).toBe("東京都港区六本木1-2-3");
  });

  it("H/I/J が全て空なら propertyAddress=null", () => {
    const rows = [
      ["", "", "", "", "", "土地", "", "", "", "", "100番1", ""],
    ];
    const [row] = parseReceptionRows(rows);
    expect(row.propertyAddress).toBeNull();
  });

  it("H のみ存在するとき propertyAddress=H の値", () => {
    const rows = [
      ["", "", "", "", "", "土地", "", "東京都", "", "", "100番1", ""],
    ];
    const [row] = parseReceptionRows(rows);
    expect(row.propertyAddress).toBe("東京都");
  });

  it("F/H/I/J/K が全て空なら excluded=empty", () => {
    const rows = [["1", "DL", "番号", "日付", "新既", "", "原因", "", "", "", "", "他"]];
    const [row] = parseReceptionRows(rows);
    expect(row.excluded).toBe("empty");
  });

  it("通常のデータ行は excluded=undefined", () => {
    const rows = [
      ["1", "", "", "", "", "土地", "", "東京都", "港区", "六本木", "1-2-3", ""],
    ];
    const [row] = parseReceptionRows(rows);
    expect(row.excluded).toBeUndefined();
  });

  it("H=都道府県 かつ I=区 はヘッダ反復として excluded=header_repeat", () => {
    const rows = [
      ["No", "DL", "番号", "受付日", "新既", "区分", "原因", "都道府県", "区", "住所", "番地", "他"],
    ];
    const [row] = parseReceptionRows(rows);
    expect(row.excluded).toBe("header_repeat");
  });

  it("先頭14列に「合計」が単独で入れば excluded=aggregate", () => {
    const rows = [
      ["", "", "合計", "", "", "", "", "", "", "", "", ""],
    ];
    const [row] = parseReceptionRows(rows);
    expect(row.excluded).toBe("aggregate");
  });

  it("「合計金額」など部分一致は除外しない（単独値のみ対象）", () => {
    const rows = [
      ["", "", "合計金額", "", "", "土地", "", "東京都", "港区", "六本木", "1-2-3", ""],
    ];
    const [row] = parseReceptionRows(rows);
    expect(row.excluded).toBeUndefined();
  });

  it("F=共担（共同担保付随行）は excluded=co_collateral", () => {
    const rows = [
      ["1", "DL", "番号", "日付", "新既", "共担", "原因", "", "", "", "", "他"],
    ];
    const [row] = parseReceptionRows(rows);
    expect(row.excluded).toBe("co_collateral");
  });
});

// ---------- parseOwnerRows ----------

describe("parseOwnerRows", () => {
  it("「物件住所」ヘッダがあれば紐づけキーに使い、所有者住所は4列連結で組み立てる", () => {
    // 実データ準拠: ['No','DM','物件住所','〒','都道府県','所有者市区郡','所有者住所','建物名','所有者名']
    const headers = [
      "No", "DM", "物件住所", "〒", "都道府県",
      "所有者市区郡", "所有者住所", "建物名", "所有者名",
    ];
    const rows = [[
      "1", "〇", "東京都世田谷区1-2-3", "154-0001", "東京都",
      "世田谷区", "1-2-3", "サンプル荘", "山田 花子",
    ]];
    const [o] = parseOwnerRows(headers, rows);
    expect(o.name).toBe("山田 花子");
    expect(o.propertyAddress).toBe("東京都世田谷区1-2-3");
    // matchKey は 物件住所 列の値を正規化したもの（C列ではない）
    expect(o.matchKey).toBe("東京都世田谷区1-2-3");
    // 表示用住所は 都道府県+市区郡+所有者住所+建物名 の連結
    expect(o.address).toBe("東京都世田谷区1-2-3サンプル荘");
    expect(o.prefecture).toBe("東京都");
    expect(o.city).toBe("世田谷区");
    expect(o.streetAddress).toBe("1-2-3");
    expect(o.buildingName).toBe("サンプル荘");
    expect(o.zip).toBe("154-0001");
    expect(o.dm).toBe("〇");
  });

  it("「物件住所」ヘッダが無い場合は C列 (index 2) で後方互換", () => {
    const headers = ["A", "B", "所在地", "氏名", "住所", "建物名", "部屋番号", "郵便番号"];
    const rows = [
      ["", "", "東京都港区1-2-3 100", "山田太郎", "1-2-3", "XXマンション", "101", "105-0001"],
    ];
    const [o] = parseOwnerRows(headers, rows);
    expect(o.cColumn).toBe("東京都港区1-2-3 100");
    expect(o.propertyAddress).toBeNull();
    // C列フォールバック
    expect(o.matchKey).toBe("東京都港区1-2-3100");
    expect(o.name).toBe("山田太郎");
    // 連結: prefecture/city 無い場合は streetAddress + buildingName
    expect(o.address).toBe("1-2-3XXマンション");
    expect(o.streetAddress).toBe("1-2-3");
    expect(o.buildingName).toBe("XXマンション");
    expect(o.roomNo).toBe("101");
    expect(o.zip).toBe("105-0001");
    expect(o.dm).toBeNull();
  });

  it("別名ヘッダ（所有者氏名/マンション名/号室/〒）も拾う", () => {
    const headers = ["X", "Y", "Z", "所有者氏名", "所有者住所", "マンション名", "号室", "〒"];
    const rows = [["", "", "東京都港区1-2-3", "A", "東京都港区1-2-3", "YY", "202", "100-0001"]];
    const [o] = parseOwnerRows(headers, rows);
    expect(o.name).toBe("A");
    expect(o.buildingName).toBe("YY");
    expect(o.roomNo).toBe("202");
    expect(o.zip).toBe("100-0001");
  });

  it("空白の値は null。連結対象が全て空なら address も null", () => {
    const headers = ["", "", "", "氏名", "住所", "建物名", "部屋番号", "郵便番号"];
    const rows = [["", "", "", "  ", "", "", "", ""]];
    const [o] = parseOwnerRows(headers, rows);
    expect(o.name).toBeNull();
    expect(o.address).toBeNull();
    expect(o.streetAddress).toBeNull();
    expect(o.buildingName).toBeNull();
    expect(o.roomNo).toBeNull();
    expect(o.zip).toBeNull();
    expect(o.dm).toBeNull();
  });

  it("No 列はマッピング対象外（紐づけキーにも使われない）", () => {
    const headers = ["No", "物件住所", "所有者名"];
    const rows = [["999", "東京都中央区1-1", "佐藤 太郎"]];
    const [o] = parseOwnerRows(headers, rows);
    // matchKey は 物件住所 から作る（No=999 は無視）
    expect(o.matchKey).toBe("東京都中央区1-1");
    expect(o.name).toBe("佐藤 太郎");
  });
});

// ---------- matchReceptionToOwners ----------

describe("matchReceptionToOwners", () => {
  const r = (rowNumber: number, matchKey: string): ParsedReceptionRow => ({
    rowNumber,
    matchKey,
    fColumn: "土地",
    kColumn: "",
    lotNumber: null,
    buildingNumber: null,
  });
  const o = (rowNumber: number, matchKey: string, name = "X"): ParsedOwnerRow => ({
    rowNumber,
    matchKey,
    cColumn: "",
    name,
    address: null,
    buildingName: null,
    roomNo: null,
    zip: null,
  });

  it("同一キーは複数所有者も落とさない（共有名義）", () => {
    const map = matchReceptionToOwners(
      [r(2, "K1")],
      [o(2, "K1", "A"), o(3, "K1", "B"), o(4, "K2", "C")],
    );
    expect(map.get(2)?.map((x) => x.name)).toEqual(["A", "B"]);
  });

  it("空キーの受付帳は常に 0 件", () => {
    const map = matchReceptionToOwners([r(2, "")], [o(2, "")]);
    expect(map.get(2)).toEqual([]);
  });

  it("一致なしは 0 件", () => {
    const map = matchReceptionToOwners([r(2, "K1")], [o(2, "K2")]);
    expect(map.get(2)).toEqual([]);
  });
});

// ---------- matchPropertyByReception ----------

describe("matchPropertyByReception", () => {
  const prop = (
    id: string,
    overrides: Partial<PropertyCandidate> = {},
  ): PropertyCandidate => ({
    id,
    address: "",
    lotNumber: null,
    buildingNumber: null,
    buildingName: null,
    roomNo: null,
    ...overrides,
  });

  it("地番で一意に一致 → matched", () => {
    const out = matchPropertyByReception(
      {
        rowNumber: 2,
        matchKey: "K",
        fColumn: "土地",
        kColumn: "100-1",
        lotNumber: "100-1",
        buildingNumber: null,
      },
      [prop("p1", { lotNumber: "100-1" }), prop("p2", { lotNumber: "100-2" })],
    );
    expect(out.status).toBe("matched");
    expect(out.property?.id).toBe("p1");
  });

  it("家屋番号で一意に一致 → matched（正規化も効く）", () => {
    const out = matchPropertyByReception(
      {
        rowNumber: 2,
        matchKey: "K",
        fColumn: "建物",
        kColumn: "Ａ－１０１",
        lotNumber: null,
        buildingNumber: "Ａ－１０１",
      },
      [prop("p1", { buildingNumber: "A-101" })],
    );
    expect(out.status).toBe("matched");
    expect(out.property?.id).toBe("p1");
  });

  it("複数ヒット → multiple + candidates", () => {
    const out = matchPropertyByReception(
      {
        rowNumber: 2,
        matchKey: "K",
        fColumn: "土地",
        kColumn: "100",
        lotNumber: "100",
        buildingNumber: null,
      },
      [prop("p1", { lotNumber: "100" }), prop("p2", { lotNumber: "100" })],
    );
    expect(out.status).toBe("multiple");
    expect(out.candidates?.map((c) => c.id)).toEqual(["p1", "p2"]);
  });

  it("該当なし → not_found", () => {
    const out = matchPropertyByReception(
      {
        rowNumber: 2,
        matchKey: "K",
        fColumn: "土地",
        kColumn: "999",
        lotNumber: "999",
        buildingNumber: null,
      },
      [prop("p1", { lotNumber: "100" })],
    );
    expect(out.status).toBe("not_found");
  });

  it("lot/building いずれも null → no_key", () => {
    const out = matchPropertyByReception(
      {
        rowNumber: 2,
        matchKey: "K",
        fColumn: "未定",
        kColumn: "100",
        lotNumber: null,
        buildingNumber: null,
      },
      [prop("p1", { lotNumber: "100" })],
    );
    expect(out.status).toBe("no_key");
  });
});

// ---------- buildCombinedMatches / summarizeMatches / getReviewReason ----------

describe("buildCombinedMatches + summarizeMatches", () => {
  it("reception の順序を保ちつつ owner/property を束ねる、サマリが正しい", () => {
    const reception = parseReceptionRows([
      // row1: matched + owner あり
      ["", "", "", "", "", "土地", "", "東京都", "港区", "1-2-3", "100"],
      // row2: owner なし + property not_found
      ["", "", "", "", "", "土地", "", "大阪府", "北区", "2-3", "999"],
      // row3: multiple
      ["", "", "", "", "", "土地", "", "名古屋", "中区", "3", "50"],
      // row4: no_key (F ambiguous)
      ["", "", "", "", "", "未定", "", "札幌", "北", "1", "77"],
    ]);
    const owners = parseOwnerRows(
      ["", "", "", "氏名"],
      [
        ["", "", "東京都港区1-2-3 100", "山田"],
        ["", "", "東京都港区1-2-3 100", "鈴木"], // 共有名義
        ["", "", "名古屋中区3 50", "田中"],
      ],
    );
    const properties: PropertyCandidate[] = [
      { id: "p1", address: "", lotNumber: "100", buildingNumber: null, buildingName: null, roomNo: null },
      { id: "p2", address: "", lotNumber: "50", buildingNumber: null, buildingName: null, roomNo: null },
      { id: "p3", address: "", lotNumber: "50", buildingNumber: null, buildingName: null, roomNo: null },
    ];

    const combined = buildCombinedMatches(reception, owners, properties);
    expect(combined).toHaveLength(4);

    // row1: matched + 2 owner
    expect(combined[0].owners.map((x) => x.name)).toEqual(["山田", "鈴木"]);
    expect(combined[0].propertyMatch.status).toBe("matched");
    expect(getReviewReason(combined[0])).toBeNull();

    // row2: 所有者0 + property 該当なし → review=owner_unmatched (最優先)
    expect(combined[1].owners).toEqual([]);
    expect(combined[1].propertyMatch.status).toBe("not_found");
    expect(getReviewReason(combined[1])).toBe("owner_unmatched");

    // row3: owner 1 + multiple
    expect(combined[2].owners.map((x) => x.name)).toEqual(["田中"]);
    expect(combined[2].propertyMatch.status).toBe("multiple");
    expect(getReviewReason(combined[2])).toBe("property_multiple");

    // row4: owner 0 + no_key → owner_unmatched 優先
    expect(combined[3].owners).toEqual([]);
    expect(combined[3].propertyMatch.status).toBe("no_key");
    expect(getReviewReason(combined[3])).toBe("owner_unmatched");

    const summary = summarizeMatches(reception, owners.length, combined);
    expect(summary).toEqual({
      receptionCount: 4,
      ownerCount: 3,
      ownerMatchedCount: 2,
      ownerUnmatchedCount: 2,
      propertyMatchedCount: 1,
      propertyNotFoundCount: 1,
      propertyMultipleCount: 1,
      propertyNoKeyCount: 1,
      excludedCount: 0,
      excludedEmptyCount: 0,
      excludedHeaderRepeatCount: 0,
      excludedAggregateCount: 0,
      excludedCoCollateralCount: 0,
      filteredByDlCount: 0,
      filteredByShinkiCount: 0,
    });
  });

  it("excluded 行は combined から除外され、summary.excludedCount に集計される", () => {
    const reception = parseReceptionRows([
      // data row
      ["", "", "", "", "", "土地", "", "東京都", "港区", "1-2-3", "100"],
      // empty (property cols 全空)
      ["1", "DL", "番号", "日付", "", "", "原因", "", "", "", "", "他"],
      // header_repeat
      ["No", "DL", "番号", "受付日", "新既", "区分", "原因", "都道府県", "区", "住所", "番地", "他"],
      // aggregate
      ["", "", "合計", "", "", "", "", "", "", "", "", ""],
    ]);
    expect(reception).toHaveLength(4);
    expect(reception[0].excluded).toBeUndefined();
    expect(reception[1].excluded).toBe("empty");
    expect(reception[2].excluded).toBe("header_repeat");
    expect(reception[3].excluded).toBe("aggregate");

    const combined = buildCombinedMatches(reception, [], []);
    // excluded 3 行は combined に入らない
    expect(combined).toHaveLength(1);
    expect(combined[0].reception.rowNumber).toBe(2); // 1行目=行2

    const summary = summarizeMatches(reception, 0, combined);
    expect(summary.receptionCount).toBe(4);
    expect(summary.excludedCount).toBe(3);
    expect(summary.excludedEmptyCount).toBe(1);
    expect(summary.excludedHeaderRepeatCount).toBe(1);
    expect(summary.excludedAggregateCount).toBe(1);
    // review 対象は 1 行のみ → ownerUnmatchedCount=1
    expect(summary.ownerUnmatchedCount).toBe(1);
  });
});

describe("getReviewReason 優先順位", () => {
  const base = (): CombinedMatch => ({
    reception: {
      rowNumber: 2,
      matchKey: "K",
      fColumn: "土地",
      kColumn: "100",
      lotNumber: "100",
      buildingNumber: null,
    },
    owners: [
      {
        rowNumber: 2,
        matchKey: "K",
        cColumn: "",
        name: "A",
        address: null,
        buildingName: null,
        roomNo: null,
      },
    ],
    propertyMatch: { status: "matched" },
  });

  it("owner あり + matched → null", () => {
    expect(getReviewReason(base())).toBeNull();
  });

  it("owner 0 → owner_unmatched が最優先", () => {
    const m = base();
    m.owners = [];
    m.propertyMatch = { status: "multiple", candidates: [] };
    expect(getReviewReason(m)).toBe("owner_unmatched");
  });

  it("owner あり + not_found → property_not_found", () => {
    const m = base();
    m.propertyMatch = { status: "not_found" };
    expect(getReviewReason(m)).toBe("property_not_found");
  });

  it("owner あり + multiple → property_multiple", () => {
    const m = base();
    m.propertyMatch = { status: "multiple", candidates: [] };
    expect(getReviewReason(m)).toBe("property_multiple");
  });

  it("owner あり + no_key → property_no_key", () => {
    const m = base();
    m.propertyMatch = { status: "no_key" };
    expect(getReviewReason(m)).toBe("property_no_key");
  });
});
