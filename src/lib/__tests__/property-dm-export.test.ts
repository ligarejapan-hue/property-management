/**
 * 物件宛DM export の純粋ヘルパーの単体テスト。
 * 宛先=物件住所(Property.postalCode → Building.postalCode → 空欄)、
 * 宛名=代表所有者名+敬称(個人=様/法人=御中)、複数なら「様 他共有者様」。
 *
 * 条件(21-D タスク7 承認時):
 *  1. 代表者選定は #169(owner DM export)の selectGroupRepresentative と同一基準。
 *     → 同一入力で同一要素を返すパリティを本テストで固定する。
 *  2. 敬称の複合ケース(法人代表+複数=「〇〇 御中 他共有者様」/個人代表+複数/
 *     法人単独/個人単独/法人番号なし団体(管理組合等)=御中[DQ-05 配線])を明示テスト化する。
 */
import { describe, it, expect } from "vitest";
// 条件1: 代表者選定基準を #169 と一致させるためのパリティ検証用 import(読み取りのみ)。
import { selectGroupRepresentative } from "../dm-export";
import {
  PROPERTY_DM_EXPORT_HEADERS,
  MAX_PROPERTY_DM_EXPORT_ROWS,
  OTHER_CO_OWNERS_SUFFIX,
  isPlainOwnerLevel,
  pickPropertyDmPostalSource,
  toPropertyDmPostalCell,
  selectRepresentative,
  buildPropertyDmRow,
  type PropertyDmRowProperty,
  type PropertyDmRowPropertyOwner,
} from "../property-dm-export";
import type { OwnerDisplayConfig } from "@/lib/api-helpers";

const FULL_DISPLAY = {
  name: "full",
  nameKana: "full",
  phone: "full",
  zip: "full",
  address: "full",
  note: "full",
  email: "full",
  corporateNumber: "full",
} as const;

// 敬称配線テスト用の型付き表示設定（no-explicit-any を増やさないため as unknown 経由でキャスト）。
const FULL_CFG = FULL_DISPLAY as unknown as OwnerDisplayConfig;

function po(
  over: Partial<{ isPrimary: boolean; name: string | null; corporateNumber: string | null }> = {},
): PropertyDmRowPropertyOwner {
  // 明示的に null を渡せるよう ?? ではなく `in` で既定値を出し分ける
  // (over.name = null のとき null をそのまま owner.name にしたい)。
  return {
    isPrimary: over.isPrimary ?? true,
    owner: {
      name: "name" in over ? over.name ?? null : "所有 花子",
      corporateNumber: "corporateNumber" in over ? over.corporateNumber ?? null : null,
    },
  };
}

function prop(over: Partial<PropertyDmRowProperty> = {}): PropertyDmRowProperty {
  return {
    address: "東京都千代田区1-1",
    postalCode: "100-0001",
    propertyType: "land",
    roomNo: null,
    building: null,
    ...over,
  };
}

describe("property-dm-export ヘッダ・定数", () => {
  it("ヘッダは宛先→宛名→メタの10列(列順固定)", () => {
    expect([...PROPERTY_DM_EXPORT_HEADERS]).toEqual([
      "管理ID",
      "郵便番号",
      "物件住所",
      "部屋番号",
      "所有者名",
      "敬称",
      "物件種別",
      "DM判断",
      "送付先所有者名一覧",
      "共有者数",
    ]);
    // 所有者の住所・郵便番号の列は持たない(宛先は物件住所)
    expect(PROPERTY_DM_EXPORT_HEADERS).not.toContain("所有者住所");
  });

  it("上限は10000・共有者接尾辞は『他共有者様』", () => {
    expect(MAX_PROPERTY_DM_EXPORT_ROWS).toBe(10000);
    expect(OTHER_CO_OWNERS_SUFFIX).toBe("他共有者様");
  });
});

describe("isPlainOwnerLevel(氏名生値判定)", () => {
  it("full/read/edit は true", () => {
    for (const l of ["full", "read", "edit"]) expect(isPlainOwnerLevel(l)).toBe(true);
  });
  it("partial/masked/hidden は false", () => {
    for (const l of ["partial", "masked", "hidden"]) expect(isPlainOwnerLevel(l)).toBe(false);
  });
});

describe("pickPropertyDmPostalSource(優先順位 Property→Building→空欄)", () => {
  it("Property.postalCode が非空なら Property を採用(Building 無視)", () => {
    expect(pickPropertyDmPostalSource("200-0002", "100-0001")).toBe("200-0002");
  });
  it("Property が null/空/空白のみのときだけ Building にフォールバック", () => {
    expect(pickPropertyDmPostalSource(null, "100-0001")).toBe("100-0001");
    expect(pickPropertyDmPostalSource("", "100-0001")).toBe("100-0001");
    expect(pickPropertyDmPostalSource("  ", "100-0001")).toBe("100-0001");
  });
  it("両方 null/空なら空文字", () => {
    expect(pickPropertyDmPostalSource(null, null)).toBe("");
    expect(pickPropertyDmPostalSource("", "")).toBe("");
  });
  it("Property が不妥当でも非空なら Building にフォールバックしない", () => {
    expect(pickPropertyDmPostalSource("abc", "100-0001")).toBe("abc");
  });
});

describe("toPropertyDmPostalCell(NNN-NNNN整形 + フォールバック)", () => {
  it("妥当な7桁は NNN-NNNN 整形", () => {
    expect(toPropertyDmPostalCell("1000001", null)).toBe("100-0001");
    expect(toPropertyDmPostalCell("100-0001", null)).toBe("100-0001");
  });
  it("Building にフォールバックして整形", () => {
    expect(toPropertyDmPostalCell(null, "1000001")).toBe("100-0001");
  });
  it("不妥当な値は素のまま(変形しない)", () => {
    expect(toPropertyDmPostalCell("12345", null)).toBe("12345");
  });
  it("両方空は空文字", () => {
    expect(toPropertyDmPostalCell(null, null)).toBe("");
  });
});

// 条件1: 代表者選定基準を #169 selectGroupRepresentative と同一に固定する。
describe("selectRepresentative(代表者選定・#169 と同一基準)", () => {
  it("primary を優先", () => {
    const owners = [po({ isPrimary: false, name: "非代表" }), po({ isPrimary: true, name: "代表" })];
    expect(selectRepresentative(owners).owner.name).toBe("代表");
  });
  it("primary が無ければ先頭(入力順=route で createdAt 昇順)", () => {
    const owners = [po({ isPrimary: false, name: "先頭" }), po({ isPrimary: false, name: "次" })];
    expect(selectRepresentative(owners).owner.name).toBe("先頭");
  });

  it("#169 selectGroupRepresentative と同一入力で同一要素を返す(基準一致をパリティで固定)", () => {
    // 複数の owner 配列パターンで、両関数が「同じ要素(参照一致)」を選ぶことを固定する。
    const cases: PropertyDmRowPropertyOwner[][] = [
      // primary が後ろ
      [po({ isPrimary: false, name: "A" }), po({ isPrimary: true, name: "B" })],
      // primary が複数(先頭の primary を採用)
      [po({ isPrimary: true, name: "C" }), po({ isPrimary: true, name: "D" })],
      // primary なし(先頭を採用)
      [po({ isPrimary: false, name: "E" }), po({ isPrimary: false, name: "F" })],
      // 単独
      [po({ isPrimary: false, name: "G" })],
    ];
    for (const owners of cases) {
      const mine = selectRepresentative(owners);
      // #169 の型(relationship 等)は本テスト対象外なので as any で同一配列を渡す。
      // 両関数とも isPrimary のみ参照し配列要素を返すため、参照一致で基準一致を検証できる。
      const ref = selectGroupRepresentative(owners as unknown as Parameters<typeof selectGroupRepresentative>[0]);
      expect(mine).toBe(ref as unknown as PropertyDmRowPropertyOwner);
    }
  });
});

describe("buildPropertyDmRow(1物件→1行)の基本", () => {
  it("単独所有者は『所有者名』+『様』、郵便番号は物件、共有者数1", () => {
    const row = buildPropertyDmRow(prop(), [po({ name: "単独 一郎" })], FULL_DISPLAY as any, "MGMT-1");
    expect(row["管理ID"]).toBe("MGMT-1");
    expect(row["郵便番号"]).toBe("100-0001");
    expect(row["物件住所"]).toBe("東京都千代田区1-1");
    expect(row["所有者名"]).toBe("単独 一郎");
    expect(row["敬称"]).toBe("様");
    expect(row["物件種別"]).toBe("土地");
    expect(row["DM判断"]).toBe("送付可");
    expect(row["送付先所有者名一覧"]).toBe("単独 一郎");
    expect(row["共有者数"]).toBe("1");
  });

  it("Property.postalCode が空なら Building.postalCode を採用", () => {
    const row = buildPropertyDmRow(
      prop({ postalCode: null, building: { postalCode: "1000001" } }),
      [po()],
      FULL_DISPLAY as any,
      "",
    );
    expect(row["郵便番号"]).toBe("100-0001");
  });

  it("null/undefined フィールドは空文字(literal null を出力しない)", () => {
    const row = buildPropertyDmRow(
      prop({ address: null, postalCode: null, roomNo: null, building: null }),
      [po({ name: null })],
      FULL_DISPLAY as any,
      null,
    );
    expect(row["管理ID"]).toBe("");
    expect(row["郵便番号"]).toBe("");
    expect(row["物件住所"]).toBe("");
    expect(row["部屋番号"]).toBe("");
    expect(row["所有者名"]).toBe("");
    expect(JSON.stringify(row)).not.toContain("null");
  });

  it("所有者名は maskValue を通す(partial は先頭3+***)", () => {
    const row = buildPropertyDmRow(
      prop(),
      [po({ name: "山田太郎花子" })],
      { ...FULL_DISPLAY, name: "partial" } as any,
      "",
    );
    expect(row["所有者名"]).toBe("山田太***");
  });
});

// 条件2: 敬称の複合ケースを明示テスト化する。
describe("buildPropertyDmRow 敬称の複合ケース(個人=様 / 法人=御中 / 複数=…他共有者様)", () => {
  it("個人単独 → 敬称『様』", () => {
    const row = buildPropertyDmRow(prop(), [po({ name: "個人 太郎", corporateNumber: null })], FULL_DISPLAY as any, "");
    expect(row["所有者名"]).toBe("個人 太郎");
    expect(row["敬称"]).toBe("様");
    expect(row["共有者数"]).toBe("1");
  });

  it("法人単独(法人番号あり)→ 敬称『御中』", () => {
    const row = buildPropertyDmRow(
      prop(),
      [po({ name: "〇〇株式会社", corporateNumber: "1234567890123" })],
      FULL_DISPLAY as any,
      "",
    );
    expect(row["所有者名"]).toBe("〇〇株式会社");
    expect(row["敬称"]).toBe("御中");
  });

  it("法人番号なし団体(任意団体・管理組合等)→ 敬称『御中』(DQ-05 配線: 様→御中)", () => {
    const row = buildPropertyDmRow(
      prop(),
      [po({ name: "〇〇管理組合", corporateNumber: null })],
      FULL_CFG,
      "",
    );
    expect(row["所有者名"]).toBe("〇〇管理組合");
    expect(row["敬称"]).toBe("御中");
  });

  it("法人番号なし『〇〇株式会社』(法人格マーカ)→ 敬称『御中』", () => {
    const row = buildPropertyDmRow(
      prop(),
      [po({ name: "〇〇株式会社", corporateNumber: null })],
      FULL_CFG,
      "",
    );
    expect(row["敬称"]).toBe("御中");
  });

  it("法人番号なし組織名が代表 + 複数所有者 → 敬称『御中 他共有者様』", () => {
    const owners = [
      po({ isPrimary: true, name: "〇〇自治会", corporateNumber: null }),
      po({ isPrimary: false, name: "共有 個人", corporateNumber: null }),
    ];
    const row = buildPropertyDmRow(prop(), owners, FULL_CFG, "");
    expect(row["所有者名"]).toBe("〇〇自治会");
    expect(row["敬称"]).toBe("御中 他共有者様");
    expect(row["送付先所有者名一覧"]).toBe("〇〇自治会、共有 個人");
    expect(row["共有者数"]).toBe("2");
  });

  it("個人代表 + 複数所有者 → 敬称『様 他共有者様』", () => {
    const owners = [
      po({ isPrimary: true, name: "代表 太郎", corporateNumber: null }),
      po({ isPrimary: false, name: "共有 次郎", corporateNumber: null }),
    ];
    const row = buildPropertyDmRow(prop(), owners, FULL_DISPLAY as any, "");
    expect(row["所有者名"]).toBe("代表 太郎");
    expect(row["敬称"]).toBe("様 他共有者様");
    expect(row["送付先所有者名一覧"]).toBe("代表 太郎、共有 次郎");
    expect(row["共有者数"]).toBe("2");
  });

  it("法人代表 + 複数所有者 → 敬称『御中 他共有者様』(所有者名は法人名)", () => {
    // 例:「〇〇株式会社 御中 他共有者様」(所有者名列=〇〇株式会社 / 敬称列=御中 他共有者様)
    const owners = [
      po({ isPrimary: true, name: "〇〇株式会社", corporateNumber: "1234567890123" }),
      po({ isPrimary: false, name: "共有 個人", corporateNumber: null }),
    ];
    const row = buildPropertyDmRow(prop(), owners, FULL_DISPLAY as any, "");
    expect(row["所有者名"]).toBe("〇〇株式会社");
    expect(row["敬称"]).toBe("御中 他共有者様");
    expect(row["送付先所有者名一覧"]).toBe("〇〇株式会社、共有 個人");
    expect(row["共有者数"]).toBe("2");
  });
});
