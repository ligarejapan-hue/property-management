// src/lib/__tests__/sales-sheet-picker-page-source.test.ts
/**
 * /sales-sheets/new（販売図面ピッカー）page のソース静的検証。
 * node 環境ゆえ provider 必須の client page は実 render せず、
 * F12 プロバイダ3点セットと部品配線をソース文字列で固定する（nav-wire-source と同方針）。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const PAGE_SRC = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/(dashboard)/sales-sheets/new/page.tsx"),
  "utf8",
);

describe("sales-sheets/new page — F12 プロバイダ3点セット", () => {
  it("(1) provider 配布値から導出（useScreenProtection）し page-local permissions fetch をしない", () => {
    expect(PAGE_SRC).toMatch(/useScreenProtection\(\)/);
    expect(PAGE_SRC).not.toMatch(/\/api\/me\/permissions/);
  });

  it("(2) 進入時 refresh（refetchPermissions + ref ガード）", () => {
    expect(PAGE_SRC).toMatch(/refetchPermissions\(\)/);
    expect(PAGE_SRC).toMatch(/permissionsRefreshRequestedRef/);
  });

  it("(3) fail-safe collapse（pending/loading 中は権限なしへ倒す）", () => {
    expect(PAGE_SRC).toMatch(/permissionsRefreshPending \|\| permissionsLoading\s*\?\s*\[\]/);
  });
});

describe("sales-sheets/new page — 配線", () => {
  it("ピッカー表示・作成ダイアログ・登録モーダルを配線している", () => {
    expect(PAGE_SRC).toMatch(/SalesSheetPropertyPicker/);
    expect(PAGE_SRC).toMatch(/SalesSheetCreateDialog/);
    expect(PAGE_SRC).toMatch(/NewPropertyModal/);
  });

  it("登録モーダルに typeFilter / onCreated を渡す（登録→そのまま作成ダイアログ）", () => {
    expect(PAGE_SRC).toMatch(/typeFilter=/);
    expect(PAGE_SRC).toMatch(/onCreated=/);
    expect(PAGE_SRC).toMatch(/SALES_SHEET_REGISTRABLE_PROPERTY_TYPES/);
  });

  it("一覧は fetchProperties + buildPickerListParams（propertyTypes 絞り）で取得する", () => {
    expect(PAGE_SRC).toMatch(/fetchProperties\(buildPickerListParams/);
  });

  it("作成ダイアログは key={selected.id} で remount（入力値の物件間持ち越し防止）", () => {
    expect(PAGE_SRC).toMatch(/key=\{selected\.id\}/);
  });
});
