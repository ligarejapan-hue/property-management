import { describe, it, expect } from "vitest";
import { buildPropertyCreateData, resolvePropertyField } from "@/lib/import-row-field-map";
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
