import { describe, it, expect } from "vitest";
import {
  buildOwnerCreateData,
  buildPropertyCreateData,
  resolvePropertyField,
  rowFieldMapExtra,
  ROW_FIELD_MAP_KEY,
} from "@/lib/import-row-field-map";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROPERTY_CSV_COLUMN_MAP } from "@/lib/csv-parser";

// 要確認・エラーの取込行を「作成」「再試行」で確定したとき、CSV 取込で入るはずの欄が落ちていた
// (部屋番号・階・専有面積など区分の欄と郵便番号)。確定側の読み替えを CSV 取込と同じにする。
const ADDR = "東京都大田区南雪谷1丁目1";

describe("取込行の確定で部屋の欄を落とさない", () => {
  it("部屋番号・階・面積・間取りなどを CSV 取込と同じ型で入れる", () => {
    const d = buildPropertyCreateData(
      {
        "住所": ADDR,
        "マンション名": "パーク第一",
        "部屋番号": " 201 ",
        "階": "2",
        "専有面積": "55.3",
        "バルコニー面積": "8.1",
        "間取り": " 2LDK ",
        "向き": " 南 ",
        "管理費": "12000",
        "修繕積立金": "9000",
        "入居状況": "vacant",
        "持分備考": "1/2",
      },
      "u",
    );
    expect(d).toMatchObject({
      propertyType: "apartment_unit",
      buildingName: "パーク第一",
      roomNo: "201",
      floorNo: 2,
      exclusiveArea: 55.3,
      balconyArea: 8.1,
      layoutType: "2LDK",
      orientation: "南",
      managementFee: 12000,
      repairReserveFee: 9000,
      occupancyStatus: "vacant",
      ownershipShareNote: "1/2",
    });
  });

  it("号室・階数の別名も読む", () => {
    const d = buildPropertyCreateData({ "住所": ADDR, "号室": "305", "階数": "3" }, "u");
    expect(d).toMatchObject({ roomNo: "305", floorNo: 3 });
  });

  it("数字でない階・面積・管理費は入れない(CSV 取込と同じ)", () => {
    const d = buildPropertyCreateData(
      { "住所": ADDR, "階": "二階", "専有面積": "広い", "管理費": "なし" },
      "u",
    );
    expect(d).not.toHaveProperty("floorNo");
    expect(d).not.toHaveProperty("exclusiveArea");
    expect(d).not.toHaveProperty("managementFee");
  });

  it("入居状況は決まった値だけ(それ以外は入れない)", () => {
    const d = buildPropertyCreateData({ "住所": ADDR, "入居状況": "空室" }, "u");
    expect(d).not.toHaveProperty("occupancyStatus");
  });

  it("郵便番号は7桁をハイフンなしにそろえ、不正な値は入れない", () => {
    expect(buildPropertyCreateData({ "住所": ADDR, "郵便番号": "145-0066" }, "u").postalCode).toBe("1450066");
    expect(buildPropertyCreateData({ "住所": ADDR, "郵便番号": "12345" }, "u")).not.toHaveProperty("postalCode");
  });

  it("種別の日本語(土地・区分マンションなど)は値に直し、知らない値は不明にする", () => {
    expect(buildPropertyCreateData({ "住所": ADDR, "種別": "土地" }, "u").propertyType).toBe("land");
    expect(buildPropertyCreateData({ "住所": ADDR, "種別": "区分マンション" }, "u").propertyType).toBe("apartment_unit");
    expect(buildPropertyCreateData({ "住所": ADDR, "種別": "ビル" }, "u").propertyType).toBe("unknown");
  });

  it("登記状況・DM判断の決まっていない値は入れない(既定値になる)", () => {
    const d = buildPropertyCreateData({ "住所": ADDR, "登記状況": "済", "DM判断": "送る" }, "u");
    expect(d.registryStatus).toBe("unconfirmed");
    expect(d.dmStatus).toBe("hold");
  });
});

describe("確定側の列の読み替えは CSV 取込と同じ", () => {
  // 棟郵便番号は物件ではなく棟に入れる欄なので、確定側(物件を作るだけ)では扱わない。
  const NOT_PROPERTY_FIELDS = new Set(["buildingPostalCode"]);

  it("CSV 取込が物件の欄に読む見出しは、確定側でも同じ欄に読む", () => {
    const mismatches: string[] = [];
    for (const [header, field] of Object.entries(PROPERTY_CSV_COLUMN_MAP)) {
      if (NOT_PROPERTY_FIELDS.has(field)) continue;
      if (resolvePropertyField(header) !== field) mismatches.push(`${header}→${field}`);
    }
    expect(mismatches).toEqual([]);
  });

  it("「物件名」は読まない(戸建が区分になるのを防ぐ・CSV 取込と同じ)", () => {
    expect(resolvePropertyField("物件名")).toBeUndefined();
  });
});

describe("取込で画面から指定した列の対応を、確定でも使う(@codex P1)", () => {
  // ファイルの見出し=表の見出し、として行に付ける表を作る。
  const fieldMapOf = (m: Record<string, string>) => rowFieldMapExtra(m, Object.keys(m));

  it("物件: 行に残った表(所在地→住所・号→部屋番号)で読み替える", () => {
    const fieldMap = fieldMapOf({ "所在地": "address", "号": "roomNo", "物件の名前": "buildingName" });
    const d = buildPropertyCreateData(
      { "所在地": ADDR, "号": "201", "物件の名前": "パーク第一", ...fieldMap },
      "u",
    );
    expect(d).toMatchObject({ address: ADDR, roomNo: "201", buildingName: "パーク第一", propertyType: "apartment_unit" });
  });

  it("物件: 表があるときは、表に無い見出しを読まない(取込と同じ結果にする)", () => {
    const fieldMap = fieldMapOf({ "所在地": "address" });
    const d = buildPropertyCreateData({ "所在地": ADDR, "階": "3", ...fieldMap }, "u");
    expect(d).not.toHaveProperty("floorNo");
  });

  it("物件: 棟郵便番号など物件に無い欄は、表にあっても入れない", () => {
    const fieldMap = fieldMapOf({ "住所": "address", "棟〒": "buildingPostalCode", "x": "createdBy" });
    const d = buildPropertyCreateData({ "住所": ADDR, "棟〒": "1450066", "x": "evil", ...fieldMap }, "u");
    expect(d).not.toHaveProperty("buildingPostalCode");
    expect(d.createdBy).toBe("u");
  });

  it("壊れた表は無視して、決まった表で読む", () => {
    const d = buildPropertyCreateData({ "住所": ADDR, "部屋番号": "201", [ROW_FIELD_MAP_KEY]: "{壊れ" }, "u");
    expect(d).toMatchObject({ address: ADDR, roomNo: "201" });
  });

  it("所有者: 行に残った表(名前→氏名)で読み替える", () => {
    const fieldMap = fieldMapOf({ "名前": "name", "TEL": "phone" });
    const d = buildOwnerCreateData({ "名前": "山田太郎", "TEL": "0312345678", ...fieldMap });
    expect(d).toMatchObject({ name: "山田太郎" });
    expect(d.phone).toBeTruthy();
  });

  it("ファイルに無い見出しの対応は残さない(@codex P1・送られた対応で DB を膨らませない)", () => {
    const extra = rowFieldMapExtra({ "所在地": "address", "無い列": "note", "もう1つ": "roomNo" }, ["所在地", "号"]);
    expect(JSON.parse(extra[ROW_FIELD_MAP_KEY])).toEqual({ "所在地": "address" });
    expect(rowFieldMapExtra({ "無い列": "note" }, ["所在地"])).toEqual({});
  });

  it("表が空なら何も足さない", () => {
    expect(rowFieldMapExtra({}, [])).toEqual({});
  });

  it("CSV取込・所有者CSV取込は、要確認・エラーの行に表を残す", () => {
    const csv = readFileSync(resolve(process.cwd(), "src/app/api/import/csv/route.ts"), "utf8");
    const owner = readFileSync(resolve(process.cwd(), "src/app/api/import/owner-csv/route.ts"), "utf8");
    expect(csv).toContain("const rowFieldMap = rowFieldMapExtra(headerToField, headers);");
    expect(owner).toContain("const rowFieldMap = rowFieldMapExtra(effectiveMapping, headers);");
    // 行ごとに作り直さない(取込ごとに1回)
    expect(csv.split("rowFieldMapExtra(").length - 1).toBe(1);
    expect(owner.split("rowFieldMapExtra(").length - 1).toBe(1);
    expect(csv).toContain("...rowFieldMap,");
    expect(owner).toContain("...rowFieldMap,");
  });
});

describe("書き出したCSVの地番・家屋番号(=\"…\")は、確定でも元の値に戻す(@codex P2)", () => {
  it("地番・家屋番号の =\"4-2\" を 4-2 にする(CSV 取込と同じ unwrapCsvTextCell)", () => {
    const d = buildPropertyCreateData(
      { "住所": ADDR, "lot_number": '="4-2"', "家屋番号": '="12-3"' },
      "u",
    );
    expect(d).toMatchObject({ lotNumber: "4-2", buildingNumber: "12-3" });
  });
  it("リンクキーは前後の空白だけ落とし、空白だけなら入れない(CSV 取込と同じ)", () => {
    expect(buildPropertyCreateData({ "住所": ADDR, "リンクキー": " 顧客ー001 " }, "u").externalLinkKey).toBe("顧客ー001");
    expect(buildPropertyCreateData({ "住所": ADDR, "リンクキー": "  " }, "u")).not.toHaveProperty("externalLinkKey");
  });
});
