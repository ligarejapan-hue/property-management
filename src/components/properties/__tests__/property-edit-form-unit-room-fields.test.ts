import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { salesFieldsFor } from "../property-edit-form";
import { updatePropertySchema } from "@/lib/validators";

/**
 * 区分マンションの部屋番号・現況・持分メモを物件の編集から直せる(発注者のご指摘 2026-10-11
 * 「部屋番号の編集をしようと思ったら物件編集からできない」)。
 * 詳細には出ているのに、編集の欄と保存の入力の決まりに無かった(専有面積などを編集できるように
 * したときに、この3つだけ漏れていた)。
 */
const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
const formSrc = read("src/components/properties/property-edit-form.tsx");
const routeSrc = read("src/app/api/properties/[id]/route.ts");

describe("保存の入力の決まり(updatePropertySchema)", () => {
  it("部屋番号・現況・持分メモを受け取る", () => {
    const parsed = updatePropertySchema.parse({
      version: 1,
      roomNo: " 201 ",
      occupancyStatus: "vacant",
      ownershipShareNote: "持分1/2",
    });
    expect(parsed).toMatchObject({ roomNo: "201", occupancyStatus: "vacant", ownershipShareNote: "持分1/2" });
  });
  it("部屋番号が空白だけなら空(null)にする", () => {
    expect(updatePropertySchema.parse({ version: 1, roomNo: "　 " }).roomNo).toBeNull();
  });
  it("変更履歴で日本語の名前が出る", () => {
    const hist = read("src/components/properties/history-tab.tsx");
    expect(hist).toContain('roomNo: "部屋番号",');
    expect(hist).toContain('occupancyStatus: "現況",');
  });
  it("空にする(null)こともできる", () => {
    const parsed = updatePropertySchema.parse({ version: 1, roomNo: null, occupancyStatus: null, ownershipShareNote: null });
    expect(parsed).toMatchObject({ roomNo: null, occupancyStatus: null, ownershipShareNote: null });
  });
  it("現況は決まった値だけ・部屋番号は長すぎると止める", () => {
    expect(() => updatePropertySchema.parse({ version: 1, occupancyStatus: "空室" })).toThrow();
    expect(() => updatePropertySchema.parse({ version: 1, roomNo: "1".repeat(51) })).toThrow();
  });
});

describe("編集の欄", () => {
  it("区分マンション(新旧どちらも)の販売の欄に、現況(選択)と持分メモがある", () => {
    for (const type of ["apartment_unit", "unit"]) {
      const fields = salesFieldsFor(type, { hasBuilding: true });
      const occ = fields.find((f) => f.key === "occupancyStatus");
      expect(occ?.label).toBe("現況");
      expect(occ?.type).toBe("select");
      expect(occ?.options?.map((o) => o.value)).toEqual(["", "vacant", "occupied", "unknown"]);
      expect(fields.find((f) => f.key === "ownershipShareNote")?.label).toBe("持分メモ");
    }
  });
  it("区分マンション以外には現況・持分メモを出さない", () => {
    for (const type of ["land", "house", "apartment_building"]) {
      expect(salesFieldsFor(type).some((f) => f.key === "occupancyStatus" || f.key === "ownershipShareNote")).toBe(false);
    }
  });
  it("部屋番号は基本の欄にあり、区分マンション(新旧)のときだけ出す", () => {
    expect(formSrc).toMatch(/\{ key: "roomNo", label: "部屋番号", type: "text", section: "基本", maxLength: 50 \}/);
    expect(formSrc).toMatch(/if \(field\.key === "roomNo"\) \{\s*return isMansionUnit\(values\.propertyType\);\s*\}/);
  });
});

describe("保存(PATCH /api/properties/[id])", () => {
  it("変更履歴の「変更前」に使うため、今の値を読む", () => {
    const selectStart = routeSrc.indexOf("const current = await prisma.property.findUnique({");
    const selectEnd = routeSrc.indexOf("if (!current)", selectStart);
    const select = routeSrc.slice(selectStart, selectEnd);
    for (const key of ["roomNo", "occupancyStatus", "ownershipShareNote"]) {
      expect(select).toContain(`${key}: true,`);
    }
  });
});
