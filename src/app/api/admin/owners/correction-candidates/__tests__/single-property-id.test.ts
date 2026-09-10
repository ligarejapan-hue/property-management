/**
 * 補正候補APIが「紐づきがちょうど1件のときの物件ID」を返す配線テスト。
 * 判定そのものは pickSinglePropertyId の単体テストが担保する(owner-property-link.test.ts)。
 * ここでは *配線* だけを見る。
 * ⚠改行を LF に正規化してから比較する。
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, it, expect } from "vitest";

const src = readFileSync(resolve(__dirname, "../route.ts"), "utf-8").replace(
  /\r\n/g,
  "\n",
);

describe("補正候補APIの singlePropertyId", () => {
  it("Candidate 型に singlePropertyId がある", () => {
    expect(src).toContain("singlePropertyId: string | null;");
  });

  it("物件の紐づきを2件だけ読む(1件か2件以上かの判別に十分・全件読まない)", () => {
    expect(src).toContain(
      "propertyOwners: { select: { propertyId: true }, take: 2 }",
    );
  });

  it("判定は純関数 pickSinglePropertyId に任せる(route に分岐を書かない)", () => {
    expect(src).toContain(
      'import { pickSinglePropertyId } from "@/lib/owner-property-link"',
    );
    expect(src).toContain("pickSinglePropertyId(owner.propertyOwners)");
  });

  it("レスポンスに singlePropertyId を載せる", () => {
    expect(src).toContain("singlePropertyId,");
  });

  it("物件の住所など物件の中身は読まない(IDだけ)", () => {
    const sel = src.match(/propertyOwners: \{ select: \{[^}]*\}/);
    expect(sel).not.toBeNull();
    expect(sel![0]).not.toContain("address");
    expect(sel![0]).not.toContain("property:");
  });
});
