import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

const schema = readFileSync("prisma/schema.prisma", "utf8");
const model = (name: string): string => {
  const m = new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`).exec(schema);
  if (!m) throw new Error(`model ${name} が見つからない`);
  return m[1];
};

describe("F3 で足す列(物件)", () => {
  const property = model("Property");
  it.each([
    ["salePrice", "Decimal?", "sale_price"],
    ["saleTaxType", "String?", "sale_tax_type"],
    ["saleTaxAmount", "Decimal?", "sale_tax_amount"],
    ["access", "String?", "access"],
    ["landArea", "Decimal?", "land_area"],
    ["landAreaMethod", "String?", "land_area_method"],
    ["totalFloorArea", "Decimal?", "total_floor_area"],
    ["builtYear", "Int?", "built_year"],
    ["builtMonth", "Int?", "built_month"],
    ["structureType", "String?", "structure_type"],
    ["aboveFloors", "Int?", "above_floors"],
    ["basementFloors", "Int?", "basement_floors"],
    ["parking", "String?", "parking"],
    ["totalUnits", "Int?", "total_units"],
    ["grossYield", "Decimal?", "gross_yield"],
    ["expectedIncome", "Decimal?", "expected_income"],
  ])("%s は %s で @map(%s)", (field, type, column) => {
    const line = property.split("\n").find((l) => new RegExp(`^\\s*${field}\\s`).test(l));
    expect(line, `${field} の宣言が無い`).toBeTruthy();
    expect(line).toContain(type);
    expect(line).toContain(`@map("${column}")`);
  });
});

describe("F3 で足す列(棟)", () => {
  const building = model("Building");
  it.each([
    ["builtMonth", "Int?", "built_month"],
    ["basementFloors", "Int?", "basement_floors"],
  ])("%s は %s で @map(%s)", (field, type, column) => {
    const line = building.split("\n").find((l) => new RegExp(`^\\s*${field}\\s`).test(l));
    expect(line, `${field} の宣言が無い`).toBeTruthy();
    expect(line).toContain(type);
    expect(line).toContain(`@map("${column}")`);
  });
});

describe("migration は列の追加だけ", () => {
  it("DROP や型変更を含まない", () => {
    const dir = readdirSync("prisma/migrations").find((d) => d.endsWith("_add_property_sales_fields"));
    expect(dir, "migration ディレクトリが無い").toBeTruthy();
    const sql = readFileSync(`prisma/migrations/${dir}/migration.sql`, "utf8");
    expect(sql).toMatch(/ALTER TABLE/);
    expect(sql).not.toMatch(/DROP/i);
    expect(sql).not.toMatch(/ALTER COLUMN/i);
  });
});
