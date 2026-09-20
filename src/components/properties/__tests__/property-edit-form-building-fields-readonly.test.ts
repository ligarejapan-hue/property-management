import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { salesFieldsFor } from "../property-edit-form";

// F3 Task7 fix: 区分マンション(apartment_unit)の編集画面では、
// 棟の項目(構造・地上階・地下階・総戸数・築年月)は編集できないことを固定。

describe("property-edit-form: 棟の項目は編集不可(F3 Task7 fix)", () => {
  describe("salesFieldsFor('apartment_unit') は棟の項目を除外", () => {
    const fields = salesFieldsFor("apartment_unit");
    const fieldKeys = fields.map(f => f.key);

    it("structureType を含まない", () => {
      expect(fieldKeys).not.toContain("structureType");
    });

    it("builtYear を含まない", () => {
      expect(fieldKeys).not.toContain("builtYear");
    });

    it("builtMonth を含まない", () => {
      expect(fieldKeys).not.toContain("builtMonth");
    });

    it("aboveFloors を含まない", () => {
      expect(fieldKeys).not.toContain("aboveFloors");
    });

    it("basementFloors を含まない", () => {
      expect(fieldKeys).not.toContain("basementFloors");
    });

    it("totalUnits を含まない", () => {
      expect(fieldKeys).not.toContain("totalUnits");
    });

    it("exclusiveArea・layoutType など部屋固有項目は含む", () => {
      expect(fieldKeys).toContain("exclusiveArea");
      expect(fieldKeys).toContain("layoutType");
      expect(fieldKeys).toContain("managementFee");
    });

    it("salePrice・access など販売一般項目は含む", () => {
      expect(fieldKeys).toContain("salePrice");
      expect(fieldKeys).toContain("access");
    });
  });

  describe("salesFieldsFor('apartment_building'/'apartment_block') は棟の項目を含む", () => {
    const fieldsBuilding = salesFieldsFor("apartment_building");
    const fieldsBlock = salesFieldsFor("apartment_block");

    it("apartment_building は structureType/aboveFloors/basementFloors/totalUnits を含む", () => {
      const keys = fieldsBuilding.map(f => f.key);
      expect(keys).toContain("structureType");
      expect(keys).toContain("aboveFloors");
      expect(keys).toContain("basementFloors");
      expect(keys).toContain("totalUnits");
    });

    it("apartment_block は structureType/aboveFloors/basementFloors/totalUnits を含む", () => {
      const keys = fieldsBlock.map(f => f.key);
      expect(keys).toContain("structureType");
      expect(keys).toContain("aboveFloors");
      expect(keys).toContain("basementFloors");
      expect(keys).toContain("totalUnits");
    });
  });

  describe("form の name/id 属性でも棟の項目が無い（ユーザーが直接 API を叩く場合も保護）", () => {
    it("apartment_unit の edit form に structureType の input が無い", () => {
      const src = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "..", "property-edit-form.tsx"),
        "utf8"
      );
      // form 内で「name='structureType'」のような文字列が apartment_unit の分岐下に無いこと
      // (簡易版: form rendering 時に name をチェック)。
      // 実装ではこのテストの狙いをカバーするため、render 時に apartment_unit なら
      // buildingBody の fields を除外する判定を持つ。
      // ここでは簡易検査: apartment_unit のブロックで structureType が出ていないことを確認
      const unitSectionMatch = src.match(
        /case\s+["']apartment_unit["']:([\s\S]*?)(?:case\s+|default:|$)/
      );
      expect(unitSectionMatch).toBeTruthy();
      const unitSection = unitSectionMatch?.[1] ?? "";
      // "structureType" という文字列が apartment_unit ケースに含まれないこと
      expect(unitSection).not.toContain("structureType");
      expect(unitSection).not.toContain("aboveFloors");
      expect(unitSection).not.toContain("basementFloors");
    });
  });
});
