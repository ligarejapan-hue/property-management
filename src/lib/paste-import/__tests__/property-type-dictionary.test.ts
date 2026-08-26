import { describe, it, expect } from "vitest";
import {
  propertyTypeForRaw,
  PROPERTY_TYPE_RULES,
} from "../property-type-dictionary";
import { PROPERTY_TYPE_LABELS } from "@/lib/property-types";

describe("propertyTypeForRaw（物件種別の言い換え）", () => {
  it("実サンプルの2つを変換する", () => {
    expect(propertyTypeForRaw("分譲マンション（区分所有）")).toEqual({
      value: "apartment_unit", confident: true,
    });
    expect(propertyTypeForRaw("一般住宅")).toEqual({ value: "house", confident: true });
  });

  it("よくある言い回しを変換する", () => {
    expect(propertyTypeForRaw("土地").value).toBe("land");
    expect(propertyTypeForRaw("戸建").value).toBe("house");
    expect(propertyTypeForRaw("一戸建て").value).toBe("house");
    expect(propertyTypeForRaw("一棟マンション").value).toBe("apartment_building");
    expect(propertyTypeForRaw("店舗").value).toBe("store");
    expect(propertyTypeForRaw("事務所").value).toBe("office");
  });

  it("⚠知らない種別は unknown にして confident=false（推測で決めない）", () => {
    expect(propertyTypeForRaw("宇宙ステーション")).toEqual({
      value: "unknown", confident: false,
    });
    expect(propertyTypeForRaw("")).toEqual({ value: "unknown", confident: false });
  });

  it("⚠「一棟マンション」を「マンション」より先に判定する（部分一致の順序）", () => {
    expect(propertyTypeForRaw("一棟マンション").value).toBe("apartment_building");
    expect(propertyTypeForRaw("マンション").value).toBe("apartment_unit");
  });

  it("★「一棟アパート」は apartment_block（一棟マンションに化けない）", () => {
    // 全体レビュー I-4: apartment_building の表示ラベルは「一棟マンション」。
    // ここが apartment_building だと、確認画面は緑（読み取れました）のまま
    // 種別だけが黙って別物になる。
    expect(propertyTypeForRaw("一棟アパート").value).toBe("apartment_block");
    expect(PROPERTY_TYPE_LABELS[propertyTypeForRaw("一棟アパート").value]).toBe("一棟アパート");
  });
});

// ---------------------------------------------------------------------------
// ★辞書の**全ルール**について、「言い換え語の意味」と「対応先の表示ラベル」が
//   食い違っていないことを機械的に固定する（全体レビュー I-4）。
//   ⚠期待表は PROPERTY_TYPE_RULES の全 needle を覆っていること自体も検査する。
//   ルールを足して表を書き忘れると、このテストが名指しで落ちる。
// ---------------------------------------------------------------------------

/** 言い換え語 → 「その語が指しているもの」の表示ラベル（property-types.ts の語彙）。 */
const EXPECTED_LABEL_FOR_PHRASE: Record<string, string> = {
  "一棟マンション": "一棟マンション",
  "一棟アパート": "一棟アパート",
  "区分所有": "区分マンション",
  "分譲マンション": "区分マンション",
  "マンション": "区分マンション",
  "一戸建": "戸建",
  "戸建": "戸建",
  "一般住宅": "戸建",
  "住宅": "戸建",
  "土地": "土地",
  "更地": "土地",
  "店舗": "店舗",
  "事務所": "事務所",
};

describe("辞書の対応先ラベルが言い換え語の意味と一致する", () => {
  it("期待表が全ルールを覆っている（ルールを足したら表も足す）", () => {
    const covered = Object.keys(EXPECTED_LABEL_FOR_PHRASE).sort();
    const needles = PROPERTY_TYPE_RULES.map((r) => r.needle).sort();
    expect(covered).toEqual(needles);
  });

  for (const rule of PROPERTY_TYPE_RULES) {
    it(`「${rule.needle}」→ ${rule.value}（表示ラベル: ${EXPECTED_LABEL_FOR_PHRASE[rule.needle]}）`, () => {
      const mapped = propertyTypeForRaw(rule.needle);
      expect(mapped.confident).toBe(true);
      expect(PROPERTY_TYPE_LABELS[mapped.value]).toBe(EXPECTED_LABEL_FOR_PHRASE[rule.needle]);
    });
  }
});
