import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { salesFieldsFor } from "../property-edit-form";
import { createPropertySchema, updatePropertySchema } from "@/lib/validators";

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

describe("新規登録(発注者の指示 2026-10-11「種別が区分マンションの場合はつける」)", () => {
  const modalSrc = read("src/components/properties/new-property-modal.tsx");
  const postSrc = read("src/app/api/properties/route.ts");
  it("登録の入力の決まりで部屋番号を受け取る(空白だけなら空・長すぎると止める)", () => {
    const base = { propertyType: "apartment_unit", address: "東京都杉並区西荻北3-1-1" };
    expect(createPropertySchema.parse({ ...base, roomNo: " 201 " }).roomNo).toBe("201");
    expect(createPropertySchema.parse({ ...base, roomNo: "　 " }).roomNo).toBeNull();
    expect(() => createPropertySchema.parse({ ...base, roomNo: "1".repeat(51) })).toThrow();
  });
  it("登録の画面では区分マンションのときだけ部屋番号の欄を出し、種別を変えたら消す", () => {
    expect(modalSrc).toMatch(/\{propertyType === "apartment_unit" && \(\s*<div>\s*<label\s+htmlFor="new-property-room-no"/);
    expect(modalSrc).toMatch(/if \(next !== "apartment_unit"\) setRoomNo\(""\);/);
    expect(modalSrc).toContain('roomNo: propertyType === "apartment_unit" ? roomNo.trim() || null : null,');
    // 入力欄では打ち切らず(物件名と同じ)、保存前に整えてから長さを見る
    expect(modalSrc).toContain('if (propertyType === "apartment_unit" && roomNo.trim().length > 50) {');
  });
  it("保存では種別に合わない部屋番号を落とす(区分マンション専用の欄の決まりを通す)", () => {
    expect(postSrc).toMatch(/const \{ roomNo \} = normalizeUnitOnlyFields\(data\.propertyType, \{ roomNo: data\.roomNo \?\? null \}\);/);
    expect(postSrc).toContain("data: { ...data, buildingName, roomNo, createdBy: session.id },");
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
