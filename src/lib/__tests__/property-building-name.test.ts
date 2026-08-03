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
  isBuildingNameTooLong,
  normalizeBuildingName,
  supportsBuildingName,
} from "@/lib/property-building-name";
import { PROPERTY_TYPE_LABELS } from "@/lib/property-types";
import {
  createPropertySchema,
  updatePropertySchema,
} from "@/lib/validators";

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

  it("⚠長すぎてもここでは切り詰めない (黙って名前が削られない)", () => {
    // 長さは入力検証が「整えてから測って超えていれば断る」で見る。
    // ここで slice すると、利用者は名前が削られたことに気づけない。
    const long = "あ".repeat(BUILDING_NAME_MAX_LENGTH + 50);
    expect(normalizeBuildingName("apartment_building", long)).toBe(long);
  });
});

describe("長さの扱い — 整えてから測り、超えたら断る (@codex #354 P2)", () => {
  it("⚠上限ちょうどの名前は、前後に空白が付いていても通る", () => {
    // 生の文字数で測ると「100文字＋空白」で 422 になり、利用者には
    // なぜ弾かれたのか分からない。
    const name = "あ".repeat(BUILDING_NAME_MAX_LENGTH);
    const parsed = createPropertySchema.safeParse({
      propertyType: "apartment_building",
      address: "東京都杉並区西荻北3-19-4",
      buildingName: `   ${name}   `,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.buildingName).toBe(name);
  });

  it("整えても上限を超える名前は断る (切り詰めない)", () => {
    const parsed = createPropertySchema.safeParse({
      propertyType: "apartment_building",
      address: "東京都杉並区西荻北3-19-4",
      buildingName: "あ".repeat(BUILDING_NAME_MAX_LENGTH + 1),
    });
    expect(parsed.success).toBe(false);
  });

  it("更新側も同じ扱い", () => {
    const name = "あ".repeat(BUILDING_NAME_MAX_LENGTH);
    const ok = updatePropertySchema.safeParse({
      version: 1,
      buildingName: `  ${name}  `,
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.buildingName).toBe(name);
    const ng = updatePropertySchema.safeParse({
      version: 1,
      buildingName: "あ".repeat(BUILDING_NAME_MAX_LENGTH + 1),
    });
    expect(ng.success).toBe(false);
  });

  it("isBuildingNameTooLong は数える前に整える", () => {
    const name = "あ".repeat(BUILDING_NAME_MAX_LENGTH);
    expect(isBuildingNameTooLong(`   ${name}   `)).toBe(false);
    expect(isBuildingNameTooLong(name + "あ")).toBe(true);
    expect(isBuildingNameTooLong("")).toBe(false);
    expect(isBuildingNameTooLong(null)).toBe(false);
  });

  it("⚠入力欄に maxLength を付けない (ブラウザが黙って実文字を削る)", () => {
    const read = (p: string) =>
      fs.readFileSync(path.join(process.cwd(), p), "utf-8");
    // 生の文字数で打ち切ると、前後に空白のある上限ちょうどの名前を貼ったとき
    // 先頭/末尾の空白のぶん実文字が消える。切り詰め禁止の方針と矛盾する。
    const modal = read("src/components/properties/new-property-modal.tsx");
    expect(modal).not.toMatch(/maxLength=/);
    const edit = read("src/components/properties/property-edit-form.tsx");
    expect(edit).not.toMatch(/maxLength=\{field\.maxLength\}/);
    // 代わりに超過を画面で伝え、保存も止める
    expect(modal).toMatch(/isBuildingNameTooLong\(buildingName\)/);
    expect(edit).toMatch(/isOverMaxLength\(field, values\[field\.key\]\)/);
    expect(edit).toMatch(/FORM_FIELDS\.find\(\(f\) => isOverMaxLength/);
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

  it("⚠変更履歴は「実際に保存した値」で作る (@codex #354 P2)", () => {
    const src = read("src/app/api/properties/[id]/route.ts");
    // 変更前の値を読むために既存の物件名を select している。
    // 選ばないと、書き換えても履歴が「空 → 〇〇」になり元の名前が残らない。
    expect(src).toMatch(/buildingName: true,/);
    // 履歴は正規化後の値を混ぜた persistedFields から作る。
    expect(src).toMatch(
      /const persistedFields = \{ \.\.\.updateFields, \.\.\.buildingNamePatch \}/,
    );
    expect(src).toMatch(/Object\.entries\(persistedFields\)/);
    // 保存も同じ値を使う (二重に組み立てない = 履歴と実データがずれない)。
    expect(src).toMatch(/data: \{\s*\.\.\.persistedFields,/);
    // 履歴を作る前に patch が確定していること (順序が逆だと記録漏れ)。
    expect(src.indexOf("const buildingNamePatch")).toBeLessThan(
      src.indexOf("const changeLogs"),
    );
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
