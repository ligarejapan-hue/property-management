/**
 * Phase 2-B UI source-assertion test.
 *
 * /admin/owners/correction page で「空白のみ」バッジが追加され、
 * addressIsWhitespaceOnly === true のときのみ描画されることを担保する。
 * 既存 address_null タブ・バッジは破壊しない。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const pageSrc = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/(dashboard)/admin/owners/correction/page.tsx",
  ),
  "utf8",
);

describe("admin/owners/correction page Phase 2-B 空白のみバッジ", () => {
  it("既存 address_null タブ表現は維持されている", () => {
    expect(pageSrc).toMatch(/address_null/);
    expect(pageSrc).toMatch(/住所なし/);
  });

  it("「空白のみ」バッジが addressIsWhitespaceOnly ガード経由で描画される", () => {
    expect(pageSrc).toMatch(/data-testid="whitespace-only-address-badge"/);
    expect(pageSrc).toMatch(/空白のみ/);
    expect(pageSrc).toMatch(
      /\{c\.addressIsWhitespaceOnly\s*&&\s*\(/,
    );
  });

  it("「空白のみ」バッジは既存 types ループの後に追加され、既存色 (yellow) と別色（orange）", () => {
    expect(pageSrc).toMatch(/bg-orange-100[^"]*text-orange-700/);
    // 既存 address_null バッジは yellow のまま
    expect(pageSrc).toMatch(/address_null:\s*"bg-yellow-100[^"]*text-yellow-700"/);
  });

  it("address 生値は出していない（c.address 直接表示が新バッジに紛れていない）", () => {
    // バッジセクション周辺で c.address を直接出していないこと
    const sectionMatch = pageSrc.match(
      /data-testid="whitespace-only-address-badge"[\s\S]{0,200}/,
    );
    expect(sectionMatch).not.toBeNull();
    const body = sectionMatch?.[0] ?? "";
    expect(body).not.toMatch(/\{c\.address\}/);
  });
});
