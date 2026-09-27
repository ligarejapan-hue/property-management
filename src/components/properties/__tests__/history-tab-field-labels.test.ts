/**
 * 変更履歴タブの項目名(FIELD_LABELS)が、変更履歴を書く経路の列を日本語で出せるか。
 * 表に無い列は内部名(salePrice など)のまま画面に出てしまう。
 * - 販売図面から物件・棟へ保存する列(apply-writeback が変更履歴を直接書く)
 * - CSV の「既存物件の更新」が書く区分マンションの8列
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const src = readFileSync(resolve(process.cwd(), "src/components/properties/history-tab.tsx"), "utf8");

const COLUMNS = [
  // 販売図面 → 物件
  "salePrice",
  "saleTaxType",
  "saleTaxAmount",
  "access",
  "landArea",
  "landAreaMethod",
  "totalFloorArea",
  "builtYear",
  "builtMonth",
  "structureType",
  "aboveFloors",
  "basementFloors",
  "parking",
  "totalUnits",
  "grossYield",
  "expectedIncome",
  // 区分マンション(販売図面・CSV の更新)
  "floorNo",
  "exclusiveArea",
  "balconyArea",
  "layoutType",
  "orientation",
  "managementFee",
  "repairReserveFee",
  "ownershipShareNote",
];

describe("変更履歴タブの項目名", () => {
  it.each(COLUMNS)("%s に日本語の項目名がある", (col) => {
    const block = src.slice(src.indexOf("const FIELD_LABELS"), src.indexOf("const SOURCE_LABELS"));
    expect(block).toMatch(new RegExp(`\\n\\s*${col}:\\s*"[^"]+"`));
  });
});
