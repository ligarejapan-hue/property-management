/**
 * 売却DM の書き込み tx が守るロック順序（設計 2026-08-08-sale-dm-external-paste-design.md §2.3）:
 *   Owner(代表所有者) → variant → 物件親行 → 子行(draft)
 *
 * ⚠混在するとデッドロックする。PR-D2 で新設する「貼り付け／適用」は凍結判定のために
 * variant を先に掴むため、既存経路が draft を先に掴んだままだと互いに待ち合う。
 * SQL の出現順をソースで固定する。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

function src(p: string) {
  return readFileSync(path.resolve(process.cwd(), p), "utf-8");
}

describe("型の設定変更(variant PATCH)のロック順序", () => {
  const s = src(
    "src/app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/route.ts",
  );

  it("variant 行を FOR UPDATE でロックする", () => {
    expect(s).toMatch(/FROM dm_variants[\s\S]{0,160}FOR UPDATE/);
  });

  it("variant のロックが draft のロックより先に来る", () => {
    const v = s.search(/FROM dm_variants[\s\S]{0,160}FOR UPDATE/);
    const d = s.search(/FROM dm_recipient_drafts[\s\S]{0,160}FOR UPDATE/);
    expect(v).toBeGreaterThan(-1);
    expect(d).toBeGreaterThan(-1);
    expect(v).toBeLessThan(d);
  });
});

describe("宛先の確定(drafts/confirm)のロック順序", () => {
  const s = src("src/app/api/properties/sale-dm/drafts/confirm/route.ts");

  it("所有者 → variant → 物件親行 の順にロックを取る", () => {
    const o = s.indexOf("lockOwnersForShare");
    const v = s.search(/FROM dm_variants[\s\S]{0,200}FOR UPDATE/);
    const p = s.search(/FROM properties[\s\S]{0,200}FOR UPDATE/);
    expect(o).toBeGreaterThan(-1);
    expect(v).toBeGreaterThan(o);
    expect(p).toBeGreaterThan(v);
  });

  it("field_staff のときだけ物件親行を取る(admin/office は不要)", () => {
    expect(s).toMatch(
      /field_staff[\s\S]{0,500}FROM properties[\s\S]{0,200}FOR UPDATE/,
    );
  });

  it("ロック後に担当範囲を再検証する(ロック前の判定だけで確定しない)", () => {
    const p = s.search(/FROM properties[\s\S]{0,200}FOR UPDATE/);
    expect(p).toBeGreaterThan(-1);
    expect(s.slice(p)).toMatch(/assignedTo/);
  });
});
