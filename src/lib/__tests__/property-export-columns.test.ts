/**
 * 物件CSV export の列レジストリ / ?columns= 解決（出力項目選択）。
 *
 * - EXPORT_COLUMNS: 安定英語キー ↔ 日本語ヘッダの単一定義（現行15列・順序）。
 * - resolveExportColumns: ?columns= 値 → 出力列。無指定=全列・既知キーのみ定義順に正規化・
 *   未知キー無視・全て無効なら全列フォールバック。
 */
import { describe, it, expect } from "vitest";
import {
  EXPORT_COLUMNS,
  resolveExportColumns,
} from "../property-export-columns";

const ALL_KEYS = [
  "mgmtId",
  "propertyType",
  "address",
  "lotNumber",
  "buildingNumber",
  "realEstateNumber",
  "registryStatus",
  "dmStatus",
  "caseStatus",
  "introductionRoute",
  "assigneeName",
  "ownerNames",
  "updatedAt",
  "createdAt",
  "postalCode",
];

const ALL_HEADERS = [
  "管理ID",
  "物件種別",
  "住所",
  "地番",
  "家屋番号",
  "不動産番号",
  "登記状況",
  "DM判断",
  "案件ステータス",
  "導入ルート",
  "担当者名",
  "所有者名",
  "更新日時",
  "作成日時",
  "郵便番号",
];

describe("EXPORT_COLUMNS", () => {
  it("現行15列を安定キー↔日本語ヘッダで定義順に保持する", () => {
    expect(EXPORT_COLUMNS.map((c) => c.key)).toEqual(ALL_KEYS);
    expect(EXPORT_COLUMNS.map((c) => c.header)).toEqual(ALL_HEADERS);
  });

  it("キーは一意", () => {
    const keys = EXPORT_COLUMNS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("resolveExportColumns", () => {
  it("null（無指定）は全列（後方互換）", () => {
    expect(resolveExportColumns(null).map((c) => c.header)).toEqual(ALL_HEADERS);
  });

  it("指定キーのみを返す", () => {
    const cols = resolveExportColumns("address,postalCode");
    expect(cols.map((c) => c.key)).toEqual(["address", "postalCode"]);
    expect(cols.map((c) => c.header)).toEqual(["住所", "郵便番号"]);
  });

  it("ユーザー指定の順序ではなく EXPORT_COLUMNS の定義順に正規化する", () => {
    // postalCode を先に書いても定義順（address が先）で返る
    const cols = resolveExportColumns("postalCode,address");
    expect(cols.map((c) => c.key)).toEqual(["address", "postalCode"]);
  });

  it("未知キーは無視する", () => {
    const cols = resolveExportColumns("address,__bogus,postalCode");
    expect(cols.map((c) => c.key)).toEqual(["address", "postalCode"]);
  });

  it("空白・空要素を無視する", () => {
    const cols = resolveExportColumns(" address , , postalCode ");
    expect(cols.map((c) => c.key)).toEqual(["address", "postalCode"]);
  });

  it("全て未知/空 → 全列フォールバック（列ゼロの無意味な CSV を出さない）", () => {
    expect(resolveExportColumns("").map((c) => c.header)).toEqual(ALL_HEADERS);
    expect(resolveExportColumns("__x,__y").map((c) => c.header)).toEqual(ALL_HEADERS);
  });

  it("重複指定は1回だけ（定義順・重複排除）", () => {
    const cols = resolveExportColumns("postalCode,address,postalCode");
    expect(cols.map((c) => c.key)).toEqual(["address", "postalCode"]);
  });
});
