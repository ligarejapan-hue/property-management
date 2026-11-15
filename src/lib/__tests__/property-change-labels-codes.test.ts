/**
 * 変更履歴・経緯の値と項目名を画面と同じ日本語で出す(2026-11-15)。
 * 「現況 - → rented」「除外申請 requested」「棟 - → (棟の ID)」と、内部の値や ID がそのまま出ていた。
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, it, expect } from "vitest";
import { LEAD_EXCLUSION_STATUS_LABELS } from "@/lib/lead-exclusion";
import {
  CHANGE_FIELD_LABELS, DELETED_BUILDING_LABEL, buildingHistoryLabel, changeFieldLabel, historyBooleanLabel, historyNameIds,
  propertyHistoryValue, userHistoryLabel,
} from "@/lib/property-change-labels";
import { BUILDING_TRACKED_FIELDS, PROPERTY_TRACKED_FIELDS } from "@/lib/property-field-constants";
import { INTRODUCTION_ROUTE_LABELS, OCCUPANCY_STATUS_LABELS, PROPERTY_TYPE_LABELS } from "@/lib/property-types";
import { updatePropertySchema } from "@/lib/validators";

describe("propertyHistoryValue(現況・除外申請・種別・導入ルート)", () => {
  it("★現況は「賃貸中」と出す(rented と英字で出さない)", () => {
    expect(propertyHistoryValue("occupancyStatus", "rented")).toBe("賃貸中");
  });

  it("★除外申請は「申請中」「認められなかった」と出す", () => {
    expect(propertyHistoryValue("leadExclusionStatus", "requested")).toBe("申請中");
    expect(propertyHistoryValue("leadExclusionStatus", "rejected")).toBe("認められなかった");
    expect(propertyHistoryValue("leadExclusionStatus", "approved")).toBe("除外された");
  });

  const TABLES: [string, Record<string, string>][] = [
    ["occupancyStatus", OCCUPANCY_STATUS_LABELS],
    ["leadExclusionStatus", LEAD_EXCLUSION_STATUS_LABELS],
    ["propertyType", PROPERTY_TYPE_LABELS],
    ["introductionRoute", INTRODUCTION_ROUTE_LABELS],
  ];

  it.each(TABLES)("%s は画面の表にある値をすべて画面の名前で出す", (field, labels) => {
    expect(Object.keys(labels).length).toBeGreaterThan(0);
    for (const [value, label] of Object.entries(labels)) {
      expect(propertyHistoryValue(field, value)).toBe(label);
    }
  });

  it.each(TABLES)("%s の知らない値・空は手を付けない(null=そのまま出す)", (field) => {
    expect(propertyHistoryValue(field, "something")).toBeNull();
    // 表の持ち主ではない名前(toString など)を拾わない。
    expect(propertyHistoryValue(field, "toString")).toBeNull();
    expect(propertyHistoryValue(field, "")).toBeNull();
    expect(propertyHistoryValue(field, null)).toBeNull();
  });
});

describe("はい・いいえ(主所有者など)", () => {
  it("★true / false の欄は「はい」「いいえ」", () => {
    expect(historyBooleanLabel("isPrimary", "true")).toBe("はい");
    expect(historyBooleanLabel("isPrimary", "false")).toBe("いいえ");
  });

  it("はい・いいえの欄ではない項目(備考など)と、ほかの値は手を付けない", () => {
    expect(historyBooleanLabel("note", "true")).toBeNull();
    expect(historyBooleanLabel("isPrimary", "yes")).toBeNull();
    expect(historyBooleanLabel("isPrimary", null)).toBeNull();
  });
});

describe("棟・担当者の ID を名前に直す", () => {
  const B1 = "d5d6aae8-1111-4111-8111-111111111111";
  const B2 = "d5d6aae8-2222-4222-8222-222222222222";
  const U1 = "66666666-6666-4666-8666-666666666666";

  it("★棟は今の名前で出す", () => {
    expect(buildingHistoryLabel(B1, new Map([[B1, "サンプルマンション"]]))).toBe("サンプルマンション");
  });

  it("★見つからない棟は「(削除・統合された棟)」(ID は出さない)", () => {
    expect(DELETED_BUILDING_LABEL).toBe("(削除・統合された棟)");
    expect(buildingHistoryLabel(B2, new Map([[B1, "サンプルマンション"]]))).toBe("(削除・統合された棟)");
    expect(buildingHistoryLabel(B2, new Map())).not.toContain(B2);
  });

  it("空(棟なし)は空のまま", () => {
    expect(buildingHistoryLabel(null, new Map())).toBeNull();
    expect(buildingHistoryLabel("", new Map())).toBeNull();
  });

  it("担当者は名前で出す。見つからなければ ID を出さず「(表示なし)」", () => {
    expect(userHistoryLabel(U1, new Map([[U1, "担当C"]]))).toBe("担当C");
    expect(userHistoryLabel(U1, new Map())).toBe("(表示なし)");
    expect(userHistoryLabel(null, new Map())).toBeNull();
  });

  it("名前を引く ID は、物件の棟・担当者の行から重複なく集める(ID の形でない値は拾わない)", () => {
    const row = (targetTable: string, fieldName: string, oldValue: string | null, newValue: string | null) => ({ targetTable, fieldName, oldValue, newValue });
    const ids = historyNameIds([
      row("properties", "buildingId", null, B1),
      row("properties", "buildingId", B1, B2),
      row("properties", "assignedTo", U1, null),
      row("properties", "note", B2, U1),
      row("properties", "buildingId", "古い値", null),
      row("buildings", "name", B1, U1),
    ]);
    expect(ids.buildingIds.sort()).toEqual([B1, B2]);
    expect(ids.userIds).toEqual([U1]);
  });
});

describe("項目名", () => {
  it("棟の「name」は氏名ではなくマンション名", () => {
    expect(changeFieldLabel("buildings", "name")).toBe("マンション名");
    expect(changeFieldLabel("owners", "name")).toBe("氏名");
    expect(changeFieldLabel("properties", "occupancyStatus")).toBe("現況");
  });

  it("表に無い項目は内部名のまま返す", () => {
    expect(changeFieldLabel("properties", "somethingNew")).toBe("somethingNew");
    expect(changeFieldLabel("properties", "toString")).toBe("toString");
  });

  it.each([
    ["postalCode", "郵便番号"], ["introductionRoute", "導入ルート"], ["buildingCoverageRatio", "建蔽率"], ["floorAreaRatio", "容積率"],
    ["heightDistrict", "高度地区"], ["firePreventionZone", "防火地域"], ["roadWidth", "道路幅員"], ["frontageWidth", "間口幅"],
    ["frontageDirection", "間口方角"], ["rosenkaYear", "路線価年度"], ["architectureNote", "建築備考"],
    ["email", "メール"], ["currentZip", "現住所の郵便番号"], ["currentAddress", "現住所"], ["builtMonth", "築月"],
  ])("%s は「%s」", (field, label) => {
    expect(CHANGE_FIELD_LABELS[field]).toBe(label);
  });
});

/**
 * 守り: 物件の保存が変更履歴に書きうる項目は、どれも日本語の項目名を持つ。
 * 新しい欄を足して表に入れ忘れると、履歴に英字の内部名(postalCode など)がそのまま出る。
 */
describe("★物件・棟の保存が履歴に書く項目は、すべて日本語の項目名を持つ", () => {
  // 物件の保存(PATCH /api/properties/:id)は、受け取った項目から version と buildingChoice を除いた全部を履歴に書く。
  const NOT_COLUMNS = ["version", "buildingChoice"];
  const routeSrc = readFileSync(resolve(process.cwd(), "src/app/api/properties/[id]/route.ts"), "utf8").replace(/\r\n/g, "\n");

  it("前提: 物件の保存は version と buildingChoice だけを除いて履歴を作る(変わったらこの守りも直す)", () => {
    expect(routeSrc).toContain("const { version, buildingChoice, ...updateFields } = data;");
    expect(routeSrc).toContain("for (const [key, newVal] of Object.entries(persistedFields))");
  });

  const fromSchema = Object.keys(updatePropertySchema.shape).filter((k) => !NOT_COLUMNS.includes(k));
  // 棟へのつなぎ直し(buildingId・buildingName)と、所有者とのつながりの項目も履歴に出る。
  const fields = [...new Set([...fromSchema, ...PROPERTY_TRACKED_FIELDS, ...BUILDING_TRACKED_FIELDS, "buildingId", "buildingName", "extraParcels", "note", "relationship", "isPrimary"])];

  it("項目が読めている", () => {
    expect(fromSchema).toContain("occupancyStatus");
    expect(fromSchema).not.toContain("version");
    expect(fields.length).toBeGreaterThan(60);
  });

  it.each(fields)("%s", (field) => {
    expect(Object.prototype.hasOwnProperty.call(CHANGE_FIELD_LABELS, field)).toBe(true);
    expect(CHANGE_FIELD_LABELS[field]).toMatch(/[^\x00-\x7F]/);
  });
});

describe("変更履歴の窓口は、棟と担当者の名前を一緒に返す", () => {
  const src = readFileSync(resolve(process.cwd(), "src/app/api/properties/[id]/change-logs/route.ts"), "utf8").replace(/\r\n/g, "\n");

  it("返す直前(伏せたあと)の行から ID を集めて、id と名前だけを読む", () => {
    expect(src).toContain("historyNameIds(visibleLogs)");
    expect(src).toMatch(/prisma\.building\.findMany\(\{\s*where: \{ id: \{ in: nameIds\.buildingIds \} \},\s*select: \{ id: true, name: true \}/);
    expect(src).toMatch(/prisma\.user\.findMany\(\{\s*where: \{ id: \{ in: nameIds\.userIds \} \},\s*select: \{ id: true, name: true \}/);
    expect(src).toContain("buildingNames,");
    expect(src).toContain("userNames,");
  });
});
