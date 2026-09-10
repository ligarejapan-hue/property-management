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

/**
 * `marker` (末尾が "{" で終わる文字列) から対応する閉じ "}" までを
 * 波かっこの深さで数えて取り出す。整形(改行/インデント)が変わっても
 * 壊れないように、リテラル文字列一致ではなく構造で block を切り出す。
 * Codex P1 (#139 finding) 対応で propertyOwners selection が
 * `where` を含む複数行の式に変わったため、一行リテラル一致では
 * 拾えなくなった。
 */
function extractBraceBlock(text: string, marker: string): string {
  const start = text.indexOf(marker);
  if (start === -1) {
    throw new Error(`marker not found: ${marker}`);
  }
  let depth = 1; // marker 自体の末尾 "{" の分
  let i = start + marker.length;
  for (; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  throw new Error(`unbalanced braces after marker: ${marker}`);
}

describe("補正候補APIの singlePropertyId", () => {
  it("Candidate 型に singlePropertyId がある", () => {
    expect(src).toContain("singlePropertyId: string | null;");
  });

  it("物件の紐づきを2件だけ読む(1件か2件以上かの判別に十分・全件読まない)", () => {
    const block = extractBraceBlock(src, "propertyOwners: {");
    expect(block).toContain("select: { propertyId: true }");
    expect(block).toContain("take: 2");
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
    // Codex P1 (#139 finding): field_staff の可視範囲を絞るため
    // `where: { property: propertyVisibilityScope } }` (createdBy/assignedTo
    // のみの絞り込み)が入るのは正当。禁止したいのは「物件の中身を select する」
    // こと(住所や `property: { select: {...} }` のようなネストした物件 select)。
    const block = extractBraceBlock(src, "propertyOwners: {");
    expect(block).not.toContain("address");
    expect(block).not.toMatch(/property:\s*\{\s*select/);
  });

  it("property:read が無いセッションには singlePropertyId を返さない(#139 finding)", () => {
    expect(src).toContain(
      'const hasPropertyRead = hasPermission(perms, "property", "read");',
    );
    expect(src).toContain(
      "const singlePropertyId = hasPropertyRead\n        ? pickSinglePropertyId(owner.propertyOwners)\n        : null;",
    );
  });

  it("field_staff の可視範囲スコープ(propertyVisibilityScopeWhere)を nested selection に適用する(#139 finding)", () => {
    expect(src).toContain(
      'import { propertyVisibilityScopeWhere } from "@/lib/property-list-query"',
    );
    expect(src).toContain(
      "const propertyVisibilityScope = propertyVisibilityScopeWhere(session);",
    );
    const block = extractBraceBlock(src, "propertyOwners: {");
    expect(block).toContain("propertyVisibilityScope");
    expect(block).toContain("where: { property: propertyVisibilityScope }");
  });
});
