/**
 * 物件名 (マンション名・アパート名) の純ロジック検証。
 *
 * 発注者要望 (2026-08-03):
 * 「物件登録時に物件種別が一棟アパート、一棟マンション、区分マンションの場合
 *   物件名を入れる部分が欲しい。ただし任意で」
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  BUILDING_NAME_MAX_LENGTH,
  PROPERTY_TYPES_WITH_BUILDING_NAME,
  normalizeBuildingName,
  supportsBuildingName,
} from "@/lib/property-building-name";
import { PROPERTY_TYPE_LABELS } from "@/lib/property-types";

describe("supportsBuildingName — どの種別で出すか", () => {
  it("発注者が挙げた3種別で出す", () => {
    expect(supportsBuildingName("apartment_block")).toBe(true); // 一棟アパート
    expect(supportsBuildingName("apartment_building")).toBe(true); // 一棟マンション
    expect(supportsBuildingName("apartment_unit")).toBe(true); // 区分マンション
  });

  it("対象の3種別のラベルが「一棟アパート/一棟マンション/区分マンション」であること", () => {
    // ⚠値とラベルの対応がずれたまま実装すると、**別の種別に欄が出る**。
    // 依頼の日本語と実装の値をここで結びつけておく。
    const labels = PROPERTY_TYPES_WITH_BUILDING_NAME.map(
      (v) => PROPERTY_TYPE_LABELS[v],
    );
    expect(labels).toEqual(["一棟アパート", "一棟マンション", "区分マンション"]);
  });

  it("土地・戸建・店舗などでは出さない", () => {
    for (const t of ["land", "house", "store", "office", "parking", "other"]) {
      expect(supportsBuildingName(t)).toBe(false);
    }
  });

  it("⚠旧値 (建物（旧）/区分（旧）) では出さない", () => {
    // 「建物（旧）」は戸建も含み得る曖昧な区分。勝手に広げると
    // 「土地なのに物件名がある」類の不整合を招く。
    expect(supportsBuildingName("building")).toBe(false);
    expect(supportsBuildingName("unit")).toBe(false);
  });

  it("未選択・null・undefined では出さない", () => {
    expect(supportsBuildingName("")).toBe(false);
    expect(supportsBuildingName(null)).toBe(false);
    expect(supportsBuildingName(undefined)).toBe(false);
  });
});

describe("normalizeBuildingName — 保存する値", () => {
  it("対象種別なら前後の空白を落として保存する", () => {
    expect(normalizeBuildingName("apartment_unit", "  リガーレ西荻  ")).toBe(
      "リガーレ西荻",
    );
  });

  it("⚠対象外の種別なら必ず null (画面に出ない値を DB に残さない)", () => {
    // 画面は種別で入力欄を出し分けるが、それだけだと API 直叩きで
    // 「土地」に物件名を入れられ、誰も直せないデータが残る。
    expect(normalizeBuildingName("land", "リガーレ西荻")).toBeNull();
    expect(normalizeBuildingName("house", "リガーレ西荻")).toBeNull();
    expect(normalizeBuildingName("building", "リガーレ西荻")).toBeNull();
  });

  it("空・空白のみ・null は null (見た目が空なのに入っている状態を作らない)", () => {
    expect(normalizeBuildingName("apartment_unit", "")).toBeNull();
    expect(normalizeBuildingName("apartment_unit", "   ")).toBeNull();
    expect(normalizeBuildingName("apartment_unit", "　　")).toBeNull(); // 全角空白
    expect(normalizeBuildingName("apartment_unit", null)).toBeNull();
    expect(normalizeBuildingName("apartment_unit", undefined)).toBeNull();
  });

  it("上限を超える入力は切り詰める", () => {
    const long = "あ".repeat(BUILDING_NAME_MAX_LENGTH + 50);
    const out = normalizeBuildingName("apartment_building", long);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(BUILDING_NAME_MAX_LENGTH);
  });
});

describe("配線 — 同じ判定を UI と API の両方が通る", () => {
  const read = (p: string) =>
    fs.readFileSync(path.join(process.cwd(), p), "utf-8");

  it("新規登録: 種別を対象外に変えたら入力値をその場で消す", () => {
    // 隠すだけだと、画面に無い値を送ることになり本人にも分からない。
    const src = read("src/components/properties/new-property-modal.tsx");
    expect(src).toMatch(
      /if \(!supportsBuildingName\(next\)\) setBuildingName\(""\)/,
    );
    expect(src).toMatch(/\{supportsBuildingName\(propertyType\) && \(/);
  });

  it("編集: いま選んでいる種別で欄を出し入れする", () => {
    const src = read("src/components/properties/property-edit-form.tsx");
    expect(src).toMatch(/supportsBuildingName\(values\.propertyType\)/);
  });

  it("⚠API 側でも normalizeBuildingName を通す (画面だけの制御にしない)", () => {
    expect(read("src/app/api/properties/route.ts")).toMatch(
      /buildingName: normalizeBuildingName\(data\.propertyType, data\.buildingName\)/,
    );
    const update = read("src/app/api/properties/[id]/route.ts");
    expect(update).toMatch(/normalizeBuildingName\(\s*effectiveType/);
    // 種別だけ対象外へ変えた更新でも、残っている物件名を消す
    expect(update).toMatch(/!supportsBuildingName\(effectiveType\)/);
  });

  it("DB 列は任意 (既存データを壊さない)", () => {
    expect(read("prisma/schema.prisma")).toMatch(
      /buildingName\s+String\?\s+@map\("building_name"\)/,
    );
    expect(
      read(
        "prisma/migrations/20260803180000_add_property_building_name/migration.sql",
      ),
    ).toMatch(/ADD COLUMN "building_name" TEXT;/);
  });
});
