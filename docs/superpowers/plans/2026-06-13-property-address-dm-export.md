# 物件宛DM export 新設 Implementation Plan (21-D タスク7)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 所有者宛DM(#169)とは別に、宛先=Property.postalCode + Property.address の「物件宛DM」用CSVを新規route+新規libのみで出力する。

**Architecture:** 既存の所有者宛DM route(`src/app/api/properties/dm-export/route.ts`)をテンプレートに、宛先を物件住所に置き換えた新route(`property-dm-export`)を新設。純粋ロジックは新lib(`property-dm-export.ts`)に分離してTDD。所有者住所グルーピングは不要で **1物件 = 1行**。宛名は所有者名(代表者+敬称、複数なら「様 他共有者様」)。郵便番号は Property.postalCode → Building.postalCode → 空欄 の優先順位でフォールバックし NNN-NNNN 整形。**既存ファイルは一切編集せず import のみ**(csv-encode / normalize / permissions / property-list-query / property-types / api-helpers / audit / validators)。

**Tech Stack:** Next.js App Router (route handler) / Prisma / Zod / Vitest。

---

## 設計判断(ユーザー承認済み 2026-06-13)

1. **宛名モデル = 所有者名(Option A)。** 代表所有者名 + 敬称(個人=様 / 法人=御中、`corporateNumber` の有無で判定)。複数所有者は `様 他共有者様`。`owner:read` + **氏名表示レベルが生値(full/read/edit)** を必須にするが、**zip/address の表示レベルは要求しない**(宛先は物件住所のため所有者の郵便番号・住所を出力しない=#169 より緩和)。`csv_export_personal:read` は所有者名がPIIのため必須。**非アーカイブ所有者0件の物件はskip + skippedCount計上**。
   - 注意: 「団体」でも法人番号が未登録の任意団体・管理組合等は **様** になる(判定材料が法人番号のみ・#169と同じ挙動)。
2. **Building.postalCode fallback = 採用。** 優先順位を明文化: **Property.postalCode(trim後非空) → Building.postalCode(trim後非空) → 空欄**。Property に値があれば(不妥当でも)それを採用し、null/空欄のときのみ Building を参照。妥当な7桁なら NNN-NNNN 整形、不妥当なら素のまま、両方空なら空欄。
   - #170(物件CSV export)は Property.postalCode のみ(データ忠実性)だが、本タスクは配達到達性が目的のため Building fallback を採用する(目的が異なるため整合)。**所有者宛DM(#169)は Owner.zip のみで Property/Building.postalCode を使わない方針を維持**(既存route無改変)。

## 衝突回避(厳守事項)

- **新規ファイルのみ作成。既存ファイルの編集は禁止。** 既存ファイルは import(読み取り)のみ。
- どうしても既存ファイル編集が必要になったら、**実装を止めてユーザーに報告**する。
- base = `5e746f4`(worktree `feat/property-address-dm-export` で作業中)。
- **schema / migration 変更禁止**(既存 Property.postalCode / Building.postalCode / Owner.corporateNumber を利用)。
- UI配線は本タスクの対象外(backendのみ・#169と同じスコープ)。

## File Structure

| ファイル | 役割 | 操作 |
|---|---|---|
| `src/lib/property-dm-export.ts` | 純粋ヘルパー(ヘッダ定義 / 敬称 / 表示レベル判定 / 郵便番号セル生成 / 代表者選定 / 行マッピング) | **新規作成** |
| `src/app/api/properties/property-dm-export/route.ts` | GET route handler(認証/権限ゲート/クエリ/上限/CSV/監査) | **新規作成** |
| `src/lib/__tests__/property-dm-export.test.ts` | 純lib の単体テスト | **新規作成** |
| `src/lib/__tests__/property-dm-export-route.test.ts` | route 統合テスト | **新規作成** |

import するだけの既存ファイル(無改変): `@/lib/csv-encode`, `@/lib/address-lookup/normalize`, `@/lib/permissions`, `@/lib/property-list-query`, `@/lib/property-types`, `@/lib/api-helpers`, `@/lib/audit`, `@/lib/validators`, `@/lib/prisma`。

## CSV 列(10列)

宛先ブロック(郵便番号・物件住所・部屋番号)→ 宛名ブロック(所有者名・敬称)→ メタ の順:

| # | 列名 | 生成元 |
|---|---|---|
| 1 | 管理ID | `loadImportSourceMap` 逆引き(無ければ空) |
| 2 | 郵便番号 | `toPropertyDmPostalCell(property.postalCode, building?.postalCode)`(NNN-NNNN / 素のまま / 空) |
| 3 | 物件住所 | `property.address`(宛先) |
| 4 | 部屋番号 | `property.roomNo`(区分マンション) |
| 5 | 所有者名 | 代表所有者の `maskValue(name, config.name)` |
| 6 | 敬称 | `honorific(corporateNumber)`、複数所有者なら ` 他共有者様` 付与 |
| 7 | 物件種別 | `PROPERTY_TYPE_LABELS[propertyType]` |
| 8 | DM判断 | `DM_STATUS_LABELS["send"]`(常に「送付可」) |
| 9 | 送付先所有者名一覧 | 物件の全(非アーカイブ)所有者名を「、」連結 |
| 10 | 共有者数 | 物件の(非アーカイブ)所有者数 |

**所有者の郵便番号・住所は出力しない**(宛先は物件住所)。これが #169 との決定的な違い。

---

## Task 1: 新lib `property-dm-export.ts`(純粋ヘルパー)

**Files:**
- Create: `src/lib/property-dm-export.ts`
- Test: `src/lib/__tests__/property-dm-export.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/property-dm-export.test.ts`:

```typescript
/**
 * 物件宛DM export の純粋ヘルパーの単体テスト。
 * 宛先=物件住所(Property.postalCode → Building.postalCode → 空欄)、
 * 宛名=代表所有者名+敬称(個人=様/法人=御中)、複数なら「様 他共有者様」。
 */
import { describe, it, expect } from "vitest";
import {
  PROPERTY_DM_EXPORT_HEADERS,
  MAX_PROPERTY_DM_EXPORT_ROWS,
  OTHER_CO_OWNERS_SUFFIX,
  honorific,
  isPlainOwnerLevel,
  pickPropertyDmPostalSource,
  toPropertyDmPostalCell,
  selectRepresentative,
  buildPropertyDmRow,
  type PropertyDmRowProperty,
  type PropertyDmRowPropertyOwner,
} from "../property-dm-export";

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

function po(
  over: Partial<{ isPrimary: boolean; name: string | null; corporateNumber: string | null }> = {},
): PropertyDmRowPropertyOwner {
  return {
    isPrimary: over.isPrimary ?? true,
    owner: {
      name: over.name ?? "所有 花子",
      corporateNumber: over.corporateNumber ?? null,
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

describe("honorific(敬称)", () => {
  it("法人番号ありは御中", () => {
    expect(honorific("1234567890123")).toBe("御中");
  });
  it("法人番号なし(null/空)は様", () => {
    expect(honorific(null)).toBe("様");
    expect(honorific(undefined)).toBe("様");
    expect(honorific("")).toBe("様");
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

describe("pickPropertyDmPostalSource(優先順位)", () => {
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

describe("selectRepresentative(代表者選定)", () => {
  it("primary を優先", () => {
    const owners = [po({ isPrimary: false, name: "非代表" }), po({ isPrimary: true, name: "代表" })];
    expect(selectRepresentative(owners).owner.name).toBe("代表");
  });
  it("primary が無ければ先頭", () => {
    const owners = [po({ isPrimary: false, name: "先頭" }), po({ isPrimary: false, name: "次" })];
    expect(selectRepresentative(owners).owner.name).toBe("先頭");
  });
});

describe("buildPropertyDmRow(1物件→1行)", () => {
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

  it("法人(法人番号あり)は御中", () => {
    const row = buildPropertyDmRow(
      prop(),
      [po({ name: "法人A", corporateNumber: "1234567890123" })],
      FULL_DISPLAY as any,
      "",
    );
    expect(row["敬称"]).toBe("御中");
  });

  it("複数所有者は『代表名』+『様 他共有者様』、一覧は全員、共有者数2", () => {
    const owners = [
      po({ isPrimary: true, name: "代表 太郎" }),
      po({ isPrimary: false, name: "共有 次郎" }),
    ];
    const row = buildPropertyDmRow(prop(), owners, FULL_DISPLAY as any, "");
    expect(row["所有者名"]).toBe("代表 太郎");
    expect(row["敬称"]).toBe("様 他共有者様");
    expect(row["送付先所有者名一覧"]).toBe("代表 太郎、共有 次郎");
    expect(row["共有者数"]).toBe("2");
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
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd ../property-management-worktrees/property-address-dm-export && npx vitest run src/lib/__tests__/property-dm-export.test.ts`
Expected: FAIL(`Cannot find module '../property-dm-export'`)

- [ ] **Step 3: 最小実装を書く**

`src/lib/property-dm-export.ts`:

```typescript
/**
 * 物件宛DM 差込 CSV 出力の純粋ヘルパー群(route から分離し単体テスト可能にする)。
 *
 * GET /api/properties/property-dm-export が「送付可(dmStatus=send)」の物件を
 * 「1 物件 = 1 行」で物件住所宛の DM 差込 CSV に展開する際の
 * ヘッダ定義・敬称判定・表示レベル判定・郵便番号セル生成・代表者選定・行マッピングを担う。
 *
 * 送付方針(21-D タスク7):
 *  - 宛先は Property.postalCode + Property.address(物件の物理住所宛)。
 *    郵便番号は Property.postalCode → Building.postalCode → 空欄 の優先順位でフォールバックする。
 *  - 宛名は代表所有者名 + 敬称(個人=様 / 法人=御中)。複数所有者は「様 他共有者様」。
 *  - 所有者の郵便番号・住所は出力しない(宛先は物件住所のため)。
 *    これにより owner zip/address の表示レベルゲートは不要(氏名のみ生値を要求)。
 *
 * PII / 表示レベル:
 *  - 所有者名のみ ownerDisplayConfig + maskValue に従う。
 *  - maskValue が「生値」を返す表示レベル(full / read / edit)でのみ氏名出力を許可する想定。
 *    その判定を isPlainOwnerLevel として route 側のゲートで再利用する(氏名のみ)。
 */
import { maskValue } from "@/lib/permissions";
import { PROPERTY_TYPE_LABELS, DM_STATUS_LABELS } from "@/lib/property-types";
import { formatPostalCode, isValidPostalCode } from "@/lib/address-lookup/normalize";
import type { OwnerDisplayConfig } from "@/lib/api-helpers";

// CSV ヘッダ(差込テンプレートの列順に厳密一致させること)。
// 宛先ブロック(郵便番号・物件住所・部屋番号)→ 宛名ブロック(所有者名・敬称)→ メタ の順。
export const PROPERTY_DM_EXPORT_HEADERS = [
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
] as const;

// 安全上限(最終 CSV 行数 = 物件数で判定する)。超過時は切り捨てず 400 にする。
export const MAX_PROPERTY_DM_EXPORT_ROWS = 10000;

// 複数所有者を 1 通にまとめた行の宛名で、代表者の敬称の後ろに付ける文言。
export const OTHER_CO_OWNERS_SUFFIX = "他共有者様";

/**
 * 敬称を返す。法人番号が非空文字列なら法人とみなして「御中」、それ以外は「様」。
 * 注: 法人番号が未登録の任意団体・管理組合等は「様」になる(判定材料が法人番号のみ)。
 */
export function honorific(corporateNumber: string | null | undefined): string {
  return typeof corporateNumber === "string" && corporateNumber.length > 0
    ? "御中"
    : "様";
}

/**
 * maskValue が「生値」をそのまま返す表示レベルの集合(氏名ゲート用)。
 * 物件宛DM は所有者名のみ生値が必須(郵便番号・住所は物件側を使うため不要)。
 */
export const PLAIN_OWNER_LEVELS: ReadonlySet<string> = new Set(["full", "read", "edit"]);

export function isPlainOwnerLevel(level: string): boolean {
  return PLAIN_OWNER_LEVELS.has(level);
}

// buildPropertyDmRow が受け取る最小限の建物・物件・所有者の形(route の select に対応)。
export interface PropertyDmRowBuilding {
  postalCode: string | null | undefined;
}

export interface PropertyDmRowProperty {
  address: string | null | undefined;
  postalCode: string | null | undefined;
  propertyType: string;
  roomNo: string | null | undefined;
  building?: PropertyDmRowBuilding | null;
}

export interface PropertyDmRowOwner {
  name: string | null | undefined;
  corporateNumber: string | null | undefined;
}

export interface PropertyDmRowPropertyOwner {
  isPrimary: boolean;
  owner: PropertyDmRowOwner;
}

/**
 * 郵便番号の採用元を優先順位で選ぶ: Property.postalCode → Building.postalCode → 空欄。
 *  - Property.postalCode が trim 後に非空ならそれを採用(不妥当でも採用・素の値を返す)。
 *  - Property が null/空/空白のみのときだけ Building.postalCode を参照する。
 *  - 両方 null/空なら空文字。
 * 整形(NNN-NNNN)は toPropertyDmPostalCell が行う。ここでは採用元の生値を返す。
 */
export function pickPropertyDmPostalSource(
  propertyPostalCode: string | null | undefined,
  buildingPostalCode: string | null | undefined,
): string {
  if (typeof propertyPostalCode === "string" && propertyPostalCode.trim() !== "") {
    return propertyPostalCode;
  }
  if (typeof buildingPostalCode === "string" && buildingPostalCode.trim() !== "") {
    return buildingPostalCode;
  }
  return "";
}

/**
 * 郵便番号セル値を生成する。
 *  - 採用元(pickPropertyDmPostalSource)が妥当な7桁なら NNN-NNNN へ整形。
 *  - 不妥当(7桁でない)なら素のまま返す(勝手に変形しない)。
 *  - 採用元が空なら空文字。
 * #170(物件CSV export)の toPostalCodeCell と同じ整形方針(妥当→整形 / 不妥当→素 / 空→空)。
 */
export function toPropertyDmPostalCell(
  propertyPostalCode: string | null | undefined,
  buildingPostalCode: string | null | undefined,
): string {
  const src = pickPropertyDmPostalSource(propertyPostalCode, buildingPostalCode);
  if (src === "") return "";
  return isValidPostalCode(src) ? formatPostalCode(src) : src;
}

/**
 * 代表所有者を選ぶ。primary 所有者があれば優先し、無ければ先頭(入力順)。
 * route 側で primary 先頭・createdAt 昇順に並べてから渡す前提(owners は非空)。
 */
export function selectRepresentative(
  owners: PropertyDmRowPropertyOwner[],
): PropertyDmRowPropertyOwner {
  return owners.find((po) => po.isPrimary) ?? owners[0];
}

/**
 * 1 物件 = 1 行(物件住所宛 1 通)を PROPERTY_DM_EXPORT_HEADERS をキーにした 1 行へマップする。
 *  - null / undefined は空文字にする(literal "null" は出力しない)。
 *  - 宛名(所有者名 + 敬称)は代表所有者を基準にする:
 *      1 名   … 所有者名 = 代表名 / 敬称 = 御中 or 様
 *      複数名 … 所有者名 = 代表名 / 敬称 = "<代表の敬称> 他共有者様"
 *  - 郵便番号は物件(→建物)由来。所有者の郵便番号・住所は出力しない。
 *  - 送付先所有者名一覧 = 全(非アーカイブ)所有者名を「、」連結。
 *  - 共有者数 = 物件の(非アーカイブ)所有者数。
 *  - 所有者名 / 一覧の各氏名は maskValue を通す。
 *  - DM判断は常に「送付可」(送付可の物件のみ出力する仕様のため)。
 */
export function buildPropertyDmRow(
  property: PropertyDmRowProperty,
  owners: PropertyDmRowPropertyOwner[],
  ownerDisplayConfig: OwnerDisplayConfig,
  importSourceValue: string | null | undefined,
): Record<(typeof PROPERTY_DM_EXPORT_HEADERS)[number], string> {
  const representative = selectRepresentative(owners);
  const repOwner = representative.owner;
  const baseHonorific = honorific(repOwner.corporateNumber);
  const isShared = owners.length > 1;

  const names = owners
    .map((po) => maskValue(po.owner.name, ownerDisplayConfig.name) ?? "")
    .filter((n) => n.length > 0);

  return {
    管理ID: importSourceValue ?? "",
    郵便番号: toPropertyDmPostalCell(property.postalCode, property.building?.postalCode),
    物件住所: property.address ?? "",
    部屋番号: property.roomNo ?? "",
    所有者名: maskValue(repOwner.name, ownerDisplayConfig.name) ?? "",
    敬称: isShared ? `${baseHonorific} ${OTHER_CO_OWNERS_SUFFIX}` : baseHonorific,
    物件種別: PROPERTY_TYPE_LABELS[property.propertyType] ?? property.propertyType,
    DM判断: DM_STATUS_LABELS["send"] ?? "送付可",
    送付先所有者名一覧: names.join("、"),
    共有者数: String(owners.length),
  };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/property-dm-export.test.ts`
Expected: PASS(全ケース green)

- [ ] **Step 5: コミット**

```bash
git add src/lib/property-dm-export.ts src/lib/__tests__/property-dm-export.test.ts
git commit -m "feat(property-dm): add pure helpers for property-addressed DM export"
```

---

## Task 2: 新route `property-dm-export/route.ts`

**Files:**
- Create: `src/app/api/properties/property-dm-export/route.ts`
- Test: `src/lib/__tests__/property-dm-export-route.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/__tests__/property-dm-export-route.test.ts`:

```typescript
/**
 * GET /api/properties/property-dm-export(物件宛DM 差込 CSV 出力)の統合テスト。
 *
 * 宛先=物件住所(Property.postalCode → Building.postalCode → 空欄 / NNN-NNNN)、
 * 宛名=代表所有者名+敬称(個人=様/法人=御中・複数は「様 他共有者様」)、1物件=1行。
 *
 * permissions / maskValue / csv-encode / property-list-query / property-types /
 * property-dm-export / address-lookup/normalize は実物を使用し、
 * 権限ゲート・マスキング・BOM/CRLF・行展開・郵便番号フォールバックを実挙動で検証する。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response {}
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});

vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(),
    getUserPermissions: vi.fn(),
    getOwnerDisplayConfig: vi.fn(),
    handleApiError: vi.fn((error: unknown) => {
      if (error instanceof MockApiError) {
        return Response.json(
          { error: { message: error.message, code: error.code } },
          { status: error.status },
        );
      }
      return Response.json(
        { error: { message: "Server error", code: "INTERNAL_ERROR" } },
        { status: 500 },
      );
    }),
  };
});

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  default: {
    property: { findMany: vi.fn(), count: vi.fn() },
    importJobRow: { findMany: vi.fn() },
    // export は CSV 生成であり送付履歴ではない。PropertyDmLog には一切書き込まない。
    propertyDmLog: { create: vi.fn(), createMany: vi.fn(), update: vi.fn() },
  },
}));

import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { GET } from "../../app/api/properties/property-dm-export/route";

const pm = prisma as unknown as {
  property: { findMany: Mock; count: Mock };
  importJobRow: { findMany: Mock };
  propertyDmLog: { create: Mock; createMany: Mock; update: Mock };
};

const PERMS_FULL = [
  { resource: "property", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "csv_export", action: "read", granted: true },
  { resource: "csv_export_personal", action: "read", granted: true },
];
const PERMS_NO_PROPERTY = PERMS_FULL.filter((p) => p.resource !== "property");
const PERMS_NO_CSV_EXPORT = PERMS_FULL.filter((p) => p.resource !== "csv_export");
const PERMS_NO_CSV_PERSONAL = PERMS_FULL.filter((p) => p.resource !== "csv_export_personal");
const PERMS_NO_OWNER = PERMS_FULL.filter((p) => p.resource !== "owner");

const FULL_DISPLAY = {
  name: "full",
  nameKana: "full",
  phone: "full",
  zip: "full",
  address: "full",
  note: "full",
  email: "full",
  corporateNumber: "full",
};

function makeOwner(over: Record<string, unknown> = {}) {
  return { name: "所有 花子", corporateNumber: null, ...over };
}

function makePropertyOwner(over: Record<string, unknown> = {}) {
  const { owner, ...rest } = over;
  return {
    isPrimary: true,
    ...rest,
    owner: makeOwner((owner as Record<string, unknown>) ?? {}),
  };
}

function makeProp(over: Record<string, unknown> = {}) {
  return {
    id: "p1",
    address: "東京都千代田区1-1",
    postalCode: "100-0001",
    propertyType: "land",
    roomNo: null,
    building: null,
    propertyOwners: [makePropertyOwner()],
    ...over,
  };
}

function makeRequest(qs = "") {
  return new Request(`http://localhost/api/properties/property-dm-export${qs}`, {
    method: "GET",
  }) as unknown as import("next/server").NextRequest;
}

function lastAudit(): any {
  return vi.mocked(writeAuditLog).mock.calls.at(-1)?.[0];
}

async function readCsv(res: Response): Promise<string> {
  const buf = new Uint8Array(await res.arrayBuffer());
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf);
}

function headerIndex(csv: string, col: string): number {
  return csv.split("\r\n")[0].replace(/^﻿/, "").split(",").indexOf(col);
}
function rowCells(csv: string, needle: string): string[] {
  const line = csv
    .split("\r\n")
    .filter((l) => l.length > 0)
    .find((l) => l.includes(needle));
  if (!line) throw new Error(`row containing ${needle} not found`);
  return line.split(",");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApiSession).mockResolvedValue({
    id: "user-admin", email: "a@a", name: "A", role: "admin",
  } as any);
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL as any);
  vi.mocked(getOwnerDisplayConfig).mockResolvedValue(FULL_DISPLAY as any);
  pm.property.findMany.mockResolvedValue([]);
  pm.property.count.mockResolvedValue(0);
  pm.importJobRow.findMany.mockResolvedValue([]);
});

describe("GET /api/properties/property-dm-export", () => {
  it("01. dmStatus=send / isArchived=false をサーバ側で強制(client の hold/no_send/includeArchived を無視)", async () => {
    pm.property.findMany.mockResolvedValue([makeProp()]);
    await GET(makeRequest("?dmStatus=no_send&includeArchived=true"));
    const where = pm.property.findMany.mock.calls[0][0].where;
    expect(where.dmStatus).toBe("send");
    expect(where.isArchived).toBe(false);
  });

  it("02. 1物件=1行(単独所有者・宛名は様)", async () => {
    pm.property.findMany.mockResolvedValue([makeProp({ address: "住所A" })]);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const csv = await readCsv(res);
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2); // ヘッダ + 1 行
    expect(csv).toContain("住所A");
    const cells = rowCells(csv, "所有 花子");
    expect(cells[headerIndex(csv, "敬称")]).toBe("様");
    expect(cells[headerIndex(csv, "DM判断")]).toBe("送付可");
  });

  it("03. 複数所有者でも 1物件=1行・敬称は『様 他共有者様』・共有者数2", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({
        propertyOwners: [
          makePropertyOwner({ owner: { name: "代表 太郎" }, isPrimary: true }),
          makePropertyOwner({ owner: { name: "共有 次郎" }, isPrimary: false }),
        ],
      }),
    ]);
    const res = await GET(makeRequest());
    const csv = await readCsv(res);
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    const cells = rowCells(csv, "代表 太郎");
    expect(cells[headerIndex(csv, "敬称")]).toBe("様 他共有者様");
    expect(cells[headerIndex(csv, "共有者数")]).toBe("2");
    expect(csv).toContain("代表 太郎、共有 次郎");
  });

  it("04. 法人(法人番号あり)は御中", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({
        propertyOwners: [
          makePropertyOwner({ owner: { name: "法人A", corporateNumber: "1234567890123" } }),
        ],
      }),
    ]);
    const res = await GET(makeRequest());
    const csv = await readCsv(res);
    expect(rowCells(csv, "法人A")[headerIndex(csv, "敬称")]).toBe("御中");
  });

  it("05. 非アーカイブ所有者0件の物件は出力されず skippedCount に反映", async () => {
    // some 述語で fetch 対象外だが、race 防御で空所有者が返っても行にしない。
    pm.property.findMany.mockResolvedValue([makeProp({ propertyOwners: [] })]);
    pm.property.count.mockResolvedValue(3);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const csv = await readCsv(res);
    expect(csv.split("\r\n").filter((l) => l.length > 0)).toHaveLength(1); // ヘッダのみ
    const audit = lastAudit();
    expect(audit.detail.resultCount).toBe(0);
    expect(audit.detail.skippedCount).toBe(3);
  });

  it("06. fetch は非アーカイブ所有者を1名以上持つ物件に限定 + take=MAX+1、select は非アーカイブ所有者のみ", async () => {
    pm.property.findMany.mockResolvedValue([makeProp()]);
    await GET(makeRequest());
    const call = pm.property.findMany.mock.calls[0][0];
    expect(call.where.AND).toContainEqual({
      propertyOwners: { some: { owner: { isArchived: false } } },
    });
    expect(call.take).toBe(10001);
    expect(call.select.propertyOwners.where).toEqual({ owner: { isArchived: false } });
    // 郵便番号フォールバック用に building.postalCode と property.postalCode を select する
    expect(call.select.postalCode).toBe(true);
    expect(call.select.building.select.postalCode).toBe(true);
  });

  it("07. 郵便番号フォールバック: Property.postalCode 空 → Building.postalCode を NNN-NNNN で出力", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({ postalCode: null, building: { postalCode: "1000001" } }),
    ]);
    const res = await GET(makeRequest());
    const csv = await readCsv(res);
    expect(rowCells(csv, "所有 花子")[headerIndex(csv, "郵便番号")]).toBe("100-0001");
  });

  it("08. 郵便番号は Property.postalCode を Building より優先", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({ postalCode: "2000002", building: { postalCode: "1000001" } }),
    ]);
    const res = await GET(makeRequest());
    const csv = await readCsv(res);
    expect(rowCells(csv, "所有 花子")[headerIndex(csv, "郵便番号")]).toBe("200-0002");
    expect(csv).not.toContain("100-0001");
  });

  it("09. formula injection 無害化(物件住所/所有者名/郵便番号)", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({
        address: "=1+1",
        postalCode: "@evil",
        propertyOwners: [makePropertyOwner({ owner: { name: "+SUM(A1:A2)" } })],
      }),
    ]);
    const res = await GET(makeRequest());
    const csv = await readCsv(res);
    expect(csv).toContain("'=1+1");
    expect(csv).toContain("'+SUM(A1:A2)");
    expect(csv).toContain("'@evil");
  });

  it("10. UTF-8 BOM + CRLF + ヘッダ列順(10列)", async () => {
    pm.property.findMany.mockResolvedValue([makeProp()]);
    const res = await GET(makeRequest());
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(buf.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const csv = new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf);
    expect(csv).toContain("\r\n");
    expect(csv).not.toMatch(/[^\r]\n/);
    expect(csv.split("\r\n")[0].replace(/^﻿/, "")).toBe(
      "管理ID,郵便番号,物件住所,部屋番号,所有者名,敬称,物件種別,DM判断,送付先所有者名一覧,共有者数",
    );
  });

  it("11. property:read 欠如で 403(副作用なし)", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_NO_PROPERTY as any);
    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
    expect(pm.property.findMany).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("12. csv_export:read 欠如で 403(副作用なし)", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_NO_CSV_EXPORT as any);
    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
    expect(pm.property.findMany).not.toHaveBeenCalled();
  });

  it("13. csv_export_personal:read 欠如で 403(副作用なし)", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_NO_CSV_PERSONAL as any);
    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
    expect(pm.property.findMany).not.toHaveBeenCalled();
  });

  it("14. owner:read 欠如で 403(副作用なし)", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_NO_OWNER as any);
    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
    expect(pm.property.findMany).not.toHaveBeenCalled();
  });

  it("15. 氏名表示レベルが masked/partial/hidden なら 403(副作用なし)", async () => {
    for (const badLevel of ["masked", "partial", "hidden"] as const) {
      vi.clearAllMocks();
      vi.mocked(getApiSession).mockResolvedValue({ id: "u", role: "admin" } as any);
      vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL as any);
      vi.mocked(getOwnerDisplayConfig).mockResolvedValue({ ...FULL_DISPLAY, name: badLevel } as any);
      pm.property.findMany.mockResolvedValue([makeProp()]);
      const res = await GET(makeRequest());
      expect(res.status, `name=${badLevel}`).toBe(403);
      expect(pm.property.findMany).not.toHaveBeenCalled();
      expect(writeAuditLog).not.toHaveBeenCalled();
    }
  });

  it("16. zip/address の表示レベルが masked/hidden でも氏名が生値なら 200(物件住所宛のため緩和)", async () => {
    // #169 との差: 所有者の zip/address は出力しないので、その表示レベルはゲートしない。
    vi.mocked(getOwnerDisplayConfig).mockResolvedValue({
      ...FULL_DISPLAY, zip: "hidden", address: "masked",
    } as any);
    pm.property.findMany.mockResolvedValue([makeProp()]);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
  });

  it("17. AuditLog は PII 非含有・action 名・件数(keyword/mgmtId 生値を残さない)", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({ propertyOwners: [makePropertyOwner({ owner: { name: "秘密 花子" } })] }),
    ]);
    await GET(
      makeRequest("?keyword=" + encodeURIComponent("東京都千代田区") + "&mgmtId=受付帳.xlsx:1行&propertyType=land"),
    );
    const audit = lastAudit();
    expect(audit.action).toBe("property_address_dm_csv_export");
    expect(audit.targetTable).toBe("properties");
    const detailStr = JSON.stringify(audit.detail);
    expect(detailStr).not.toContain("秘密 花子");
    expect(detailStr).not.toContain("東京都千代田区");
    expect(detailStr).not.toContain("受付帳.xlsx");
    for (const key of Object.keys(audit.detail)) {
      expect(key.toLowerCase()).not.toContain("owner");
    }
    expect(audit.detail.filters.propertyType).toBe("land");
    expect(audit.detail.filters.dmStatus).toBe("send");
    expect(audit.detail.filters.keyword).toBeUndefined();
    expect(audit.detail.filters.mgmtId).toBeUndefined();
  });

  it("18. 取得物件数 > MAX で 400(取込元逆引き / COUNT / AuditLog 未実行)", async () => {
    const many = Array.from({ length: 10001 }, (_, i) => makeProp({ id: `p${i}` }));
    pm.property.findMany.mockResolvedValue(many);
    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("EXPORT_LIMIT_EXCEEDED");
    expect(pm.importJobRow.findMany).not.toHaveBeenCalled();
    expect(pm.property.count).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
    expect(res.headers.get("Content-Type")).not.toBe("text/csv; charset=utf-8");
  });

  it("19. ちょうど MAX(10000)→ 200・全行出力", async () => {
    const many = Array.from({ length: 10000 }, (_, i) => makeProp({ id: `p${i}` }));
    pm.property.findMany.mockResolvedValue(many);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const csv = await readCsv(res);
    expect(csv.split("\r\n").filter((l) => l.length > 0)).toHaveLength(10001);
    expect(lastAudit().detail.resultCount).toBe(10000);
  });

  it("20. 0件 → ヘッダのみ CSV / 200", async () => {
    pm.property.findMany.mockResolvedValue([]);
    const res = await GET(makeRequest("?propertyType=land"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    const csv = await readCsv(res);
    expect(csv.split("\r\n").filter((l) => l.length > 0)).toHaveLength(1);
    expect(csv).toContain("管理ID");
  });

  it("21. レスポンスヘッダ(Content-Type / Content-Disposition=property_dm_ / Cache-Control)", async () => {
    pm.property.findMany.mockResolvedValue([makeProp()]);
    const res = await GET(makeRequest());
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    const cd = res.headers.get("Content-Disposition") ?? "";
    expect(cd).toContain("property_dm_");
    expect(cd).toContain(".csv");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("22. 管理ID(取込元)が CSV に出る", async () => {
    pm.property.findMany.mockResolvedValue([makeProp({ id: "p1" })]);
    pm.importJobRow.findMany.mockResolvedValue([
      { createdId: "p1", rowNumber: 5, rawData: { __sourceRef: "MGMT-001" }, job: { fileName: "受付帳.xlsx" } },
    ]);
    const res = await GET(makeRequest());
    expect(await readCsv(res)).toContain("MGMT-001");
  });

  it("23. PropertyDmLog には一切書き込まない(export は送付履歴ではない)", async () => {
    pm.property.findMany.mockResolvedValue([makeProp()]);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(pm.propertyDmLog.create).not.toHaveBeenCalled();
    expect(pm.propertyDmLog.createMany).not.toHaveBeenCalled();
    expect(pm.propertyDmLog.update).not.toHaveBeenCalled();
  });

  it("24. null フィールドは literal null/undefined を出力しない", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({
        address: null, postalCode: null, roomNo: null, building: null,
        propertyOwners: [makePropertyOwner({ owner: { name: "所有 花子", corporateNumber: null } })],
      }),
    ]);
    const res = await GET(makeRequest());
    const csv = await readCsv(res);
    expect(csv).not.toContain("null");
    expect(csv).not.toContain("undefined");
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run src/lib/__tests__/property-dm-export-route.test.ts`
Expected: FAIL(`Cannot find module '../../app/api/properties/property-dm-export/route'`)

- [ ] **Step 3: route 実装を書く**

`src/app/api/properties/property-dm-export/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
  handleApiError,
  ApiError,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { hasPermission } from "@/lib/permissions";
import { propertyListQuerySchema } from "@/lib/validators";
import {
  buildPropertyListWhere,
  buildPropertyListOrderBy,
  loadImportSourceMap,
} from "@/lib/property-list-query";
import { encodeCsv, sanitizeCsvCellForExcel } from "@/lib/csv-encode";
import {
  PROPERTY_DM_EXPORT_HEADERS,
  MAX_PROPERTY_DM_EXPORT_ROWS,
  isPlainOwnerLevel,
  buildPropertyDmRow,
  type PropertyDmRowProperty,
  type PropertyDmRowPropertyOwner,
} from "@/lib/property-dm-export";

// ---------- GET /api/properties/property-dm-export ----------
//
// 物件一覧と同じ検索・フィルタ・sort・field_staff スコープを共有しつつ、
// サーバ側で dmStatus=send / isArchived=false を強制し、「送付可」の物件を
// 「1 物件 = 1 行」で物件住所宛の DM 差込用 CSV に出力する。
//   - 宛先 = Property.postalCode(→ Building.postalCode フォールバック)+ Property.address。
//   - 宛名 = 代表所有者名 + 敬称(個人=様 / 法人=御中・複数は「様 他共有者様」)。
//   - 所有者の郵便番号・住所は出力しない(宛先は物件住所のため)。
//
// 安全上限: MAX_PROPERTY_DM_EXPORT_ROWS 行(最終 CSV 行 = 物件数)。1 物件 = 1 行のため
// 取得物件数の単段判定で足りる(take=MAX+1 で MAX 超なら全件性を保証できないので 400)。
//
// PII / 権限:
//  - property:read / csv_export:read / csv_export_personal:read / owner:read すべて必須
//  - 加えて owner 氏名の表示レベルが「生値を返すレベル」でなければ 403
//    (宛名に生の氏名が必須。zip/address は出力しないため表示レベルを要求しない=#169 より緩和)
//  - 権限不足時は DB 取得・CSV 生成・AuditLog 書き込みを一切行わない
//  - CSV 本文・所有者名などの PII は AuditLog に保存しない

// AuditLog の filters に残してよいキー(export route と同方針の allowlist)。
// mgmtId / keyword は PII を含み得るため除外。dmStatus は常に "send" を明示付与。
const AUDIT_FILTER_KEYS = [
  "propertyType",
  "registryStatus",
  "caseStatus",
  "introductionRoute",
  "assignedTo",
  "updatedFrom",
  "updatedTo",
  "includeArchived",
  "hasWarning",
  "sortBy",
  "sortOrder",
] as const;

export async function GET(request: NextRequest) {
  try {
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    // 権限ゲート。いずれか欠ける場合はここで 403 とし、DB 取得・CSV 生成・AuditLog は行わない。
    if (!hasPermission(permissions, "property", "read")) {
      throw new ApiError(403, "物件一覧の閲覧権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(permissions, "csv_export", "read")) {
      throw new ApiError(403, "CSV エクスポートの権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(permissions, "csv_export_personal", "read")) {
      throw new ApiError(403, "個人情報を含む CSV エクスポートの権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(permissions, "owner", "read")) {
      throw new ApiError(403, "所有者情報の閲覧権限がありません", "FORBIDDEN");
    }

    // 宛名に生の氏名が必須。氏名の表示レベルが「生値を返すレベル(full/read/edit)」でなければ 403。
    // zip/address は物件住所を使うため出力せず、表示レベルも要求しない(#169 より緩和)。
    const ownerDisplayConfig = await getOwnerDisplayConfig(session.id, permissions);
    if (!isPlainOwnerLevel(ownerDisplayConfig.name)) {
      throw new ApiError(
        403,
        "DM差込CSV出力に必要な所有者名の表示権限がありません",
        "FORBIDDEN",
      );
    }

    const { searchParams } = new URL(request.url);
    const queryObj: Record<string, string> = {};
    searchParams.forEach((value, key) => {
      queryObj[key] = value;
    });

    // page / limit は無視して全件出力するが、schema は共有のため parse はそのまま通す。
    const query = propertyListQuerySchema.parse(queryObj);

    // 一覧 API と同一の where / sort / field_staff スコープを共有ロジックで組み立てる。
    const { where, mgmtShortCircuitEmpty } = await buildPropertyListWhere(query, session);

    // サーバ側で強制: 送付可のみ・アーカイブ除外。client の dmStatus/includeArchived は無視。
    where.dmStatus = "send";
    where.isArchived = false;

    const orderBy = buildPropertyListOrderBy(query);

    // 宛名に所有者名が必須なので、非アーカイブ所有者を 1 名以上持つ物件のみ取得する
    // (既存の AND マージと同イディオム・clobber しない)。
    const whereWithOwners = {
      ...where,
      AND: [
        ...(where.AND ?? []),
        { propertyOwners: { some: { owner: { isArchived: false } } } },
      ],
    };

    const properties = mgmtShortCircuitEmpty
      ? []
      : await prisma.property.findMany({
          where: whereWithOwners,
          select: {
            id: true,
            address: true,
            postalCode: true,
            propertyType: true,
            roomNo: true,
            // 郵便番号フォールバック用に建物の郵便番号を取得する(住所は物件側を使う)。
            building: { select: { postalCode: true } },
            propertyOwners: {
              where: { owner: { isArchived: false } },
              select: {
                isPrimary: true,
                owner: { select: { name: true, corporateNumber: true } },
              },
              orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
            },
          },
          orderBy,
          take: MAX_PROPERTY_DM_EXPORT_ROWS + 1,
        });

    // 1 物件 = 1 行。take 窓(MAX+1)を埋めた = 全件性を保証できないため 400。
    // これは取込元逆引き・CSV 生成・AuditLog より前に走る安全側ガード。
    if (properties.length > MAX_PROPERTY_DM_EXPORT_ROWS) {
      throw new ApiError(
        400,
        "出力対象が上限（10,000件）を超えています。検索条件で絞り込んでください。",
        "EXPORT_LIMIT_EXCEEDED",
      );
    }

    // some 述語で所有者ありに絞っているが、race 防御として空所有者は行にしない。
    const exportable = properties.filter((p) => p.propertyOwners.length > 0);

    // 取込元(管理ID)を一括逆引き(一覧 API と共有・N+1 回避)。
    const importSourceMap = await loadImportSourceMap(
      prisma,
      exportable.map((p) => p.id),
    );

    const rows: Array<Record<string, string>> = exportable.map((p) =>
      buildPropertyDmRow(
        p as unknown as PropertyDmRowProperty,
        p.propertyOwners as unknown as PropertyDmRowPropertyOwner[],
        ownerDisplayConfig,
        importSourceMap.get(p.id) ?? "",
      ),
    );

    // skippedCount: 送付可だが非アーカイブ所有者 0 名の物件(宛名が作れず除外)を全範囲 COUNT。
    // 取得ウィンドウに依存しない正確な件数。400 経路では実行しない(上で throw 済み)。
    let skippedCount = 0;
    if (!mgmtShortCircuitEmpty) {
      skippedCount = await prisma.property.count({
        where: {
          ...where,
          AND: [
            ...(where.AND ?? []),
            { propertyOwners: { none: { owner: { isArchived: false } } } },
          ],
        },
      });
    }

    // CSV formula injection 対策: 全セルを encodeCsv に渡す前に無害化する。
    const sanitizedRows = rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key, sanitizeCsvCellForExcel(value)]),
      ),
    );

    // UTF-8 BOM + CRLF(encodeCsv の既定挙動)で Excel 互換に出力。
    const csv = encodeCsv([...PROPERTY_DM_EXPORT_HEADERS], sanitizedRows, { bom: true });

    // AuditLog は操作事実のみ。CSV 本文・所有者名などの PII は残さない。
    const filtersForLog: Record<string, unknown> = { dmStatus: "send" };
    for (const key of AUDIT_FILTER_KEYS) {
      const value = query[key];
      if (value !== undefined) filtersForLog[key] = value;
    }
    await writeAuditLog({
      userId: session.id,
      action: "property_address_dm_csv_export",
      targetTable: "properties",
      detail: {
        filters: filtersForLog,
        count: rows.length,
        resultCount: rows.length,
        skippedCount,
        exportedAt: new Date().toISOString(),
      },
    });

    const fileDate = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="property_dm_${fileDate}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/lib/__tests__/property-dm-export-route.test.ts`
Expected: PASS(24 ケース green)

- [ ] **Step 5: コミット**

```bash
git add src/app/api/properties/property-dm-export/route.ts src/lib/__tests__/property-dm-export-route.test.ts
git commit -m "feat(property-dm): add GET /api/properties/property-dm-export route"
```

---

## Task 3: 検証(tsc / eslint / 全テスト / build)

**Files:** なし(検証のみ)

- [ ] **Step 1: 型チェック**

Run: `npx tsc --noEmit`
Expected: エラー 0

- [ ] **Step 2: lint(変更分)**

Run: `npx eslint src/lib/property-dm-export.ts src/app/api/properties/property-dm-export/route.ts src/lib/__tests__/property-dm-export.test.ts src/lib/__tests__/property-dm-export-route.test.ts`
Expected: エラー 0

- [ ] **Step 3: 関連テスト + 全テスト**

Run: `npx vitest run src/lib/__tests__/property-dm-export.test.ts src/lib/__tests__/property-dm-export-route.test.ts`
Expected: 全 green
Run: `npx vitest run`
Expected: 全 green(既存テストへの回帰なし)

- [ ] **Step 4: build**

Run: `npm run build`
Expected: 成功。route manifest に `/api/properties/property-dm-export` が出現する。

- [ ] **Step 5: 禁止パス / schema 無変更の確認**

Run: `git diff --stat 5e746f4 HEAD`
Expected: 変更は新規4ファイルのみ(`src/lib/property-dm-export.ts` / `src/app/api/properties/property-dm-export/route.ts` / テスト2本)+ 本plan doc。既存ファイル(csv-parser.ts / import系 / dm-export.ts / 既存 dm-export route / schema.prisma / migrations)に**差分が無い**こと。

---

## Self-Review(spec coverage)

| spec 要件 | 対応 |
|---|---|
| 宛先 = Property.postalCode + Property.address | Task1 `buildPropertyDmRow`(郵便番号=postalCell・物件住所=address)/ route select |
| Building.postalCode fallback 採用 + 優先順位明文化 | Task1 `pickPropertyDmPostalSource`(Property→Building→空欄)・unit test / route 07・08 |
| 所有者宛DMに Building fallback を使わない方針維持 | 既存 dm-export.ts / route 無改変(Task3 Step5 で差分0確認) |
| dmStatus 条件・no_send 除外 | route `where.dmStatus="send"` / route 01 |
| AuditLog PII 非含有(件数等メタのみ) | route detail(filters allowlist + count/resultCount/skippedCount)/ route 17 |
| CSV式インジェクション対策(既存 sanitizeCsvCellForExcel・読み取りのみ) | route sanitizedRows / route 09 |
| 郵便番号 NNN-NNNN 整形(#170 formatPostalCode 再利用) | Task1 `toPropertyDmPostalCell`(formatPostalCode/isValidPostalCode import)/ unit test |
| 新規 route + 新規 lib のみ・既存編集禁止 | File Structure(新規4ファイル)/ Task3 Step5 差分確認 |
| 敬称(個人=様 / 法人=御中) | Task1 `honorific` / route 03・04 |
| worktree・base 5e746f4・schema/migration 変更禁止 | worktree 作業中・Task3 Step5 |

**Type consistency:** `PropertyDmRowProperty` / `PropertyDmRowPropertyOwner` / `PropertyDmRowOwner` / `PropertyDmRowBuilding` は Task1 で定義し Task2(route)が同名で参照。`PROPERTY_DM_EXPORT_HEADERS` / `MAX_PROPERTY_DM_EXPORT_ROWS` / `isPlainOwnerLevel` / `buildPropertyDmRow` の名前は両 Task で一致。

## スコープ外(本タスクで実装しない)

- UI 配線(画面からのダウンロード導線)。#169 と同じく backend のみ。後続タスク候補。
- VPS 反映(導線あり=別承認)。
- 物件宛DM の送付履歴(PropertyDmLog 書き込み)。export は CSV 生成のみで送付履歴は別業務フロー(route 23 で未書き込みを固定)。
