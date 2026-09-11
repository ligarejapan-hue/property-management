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
 * コメントを剥がしてから走査する(このリポジトリの既存パターンを流用。
 * field-survey-day-ops-source.test.ts 等 7 ファイルで同一定義が使われている
 * が、共有 export された実装は無いためここでも同じ定義を置く)。
 * Codex P2 (#139 finding round 3): コメントを剥がさずに `indexOf` で
 * marker を探すと、marker の文字列を "たまたま含むだけの doc comment" を
 * 実コードと取り違える(このリポジトリで実際に起きた事故と同型)。
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const codeOnly = stripComments(src);

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

/**
 * Codex P2 (#139 finding round 3): `extractBraceBlock` は `indexOf` なので
 * marker の**最初の**出現だけを見る。marker を偶然含む decoy(2つ目の
 * nested selection・意図せず似た文言のコメント等)が先に現れると、抽出対象が
 * 静かにすり替わり、本物の select がリークを生んでもテストは気づかない。
 * 呼び出し前に「(コメントを剥がした後の)出現回数が厳密に1」であることを
 * 検証し、2つ目が現れたら黙らず fail させる。
 */
function extractUniqueBraceBlock(text: string, marker: string): string {
  let occurrences = 0;
  let idx = 0;
  for (;;) {
    const found = text.indexOf(marker, idx);
    if (found === -1) break;
    occurrences++;
    idx = found + marker.length;
  }
  if (occurrences !== 1) {
    throw new Error(
      `extractUniqueBraceBlock: expected exactly 1 occurrence of ${JSON.stringify(
        marker,
      )}, found ${occurrences}. A second occurrence (real code or a decoy ` +
        `comment) would silently hijack this scan test — narrow the marker ` +
        `or update this test to disambiguate.`,
    );
  }
  return extractBraceBlock(text, marker);
}

describe("補正候補APIの singlePropertyId", () => {
  it("Candidate 型に singlePropertyId がある", () => {
    expect(codeOnly).toContain("singlePropertyId: string | null;");
  });

  it("物件の紐づきを2件だけ読む(1件か2件以上かの判別に十分・全件読まない)", () => {
    const block = extractUniqueBraceBlock(codeOnly, "propertyOwners: {");
    expect(block).toContain("select: { propertyId: true }");
    expect(block).toContain("take: 2");
  });

  it("判定は純関数 pickSinglePropertyId に任せる(route に分岐を書かない)", () => {
    expect(codeOnly).toContain(
      'import { pickSinglePropertyId } from "@/lib/owner-property-link"',
    );
    expect(codeOnly).toContain("pickSinglePropertyId(owner.propertyOwners)");
  });

  it("レスポンスに singlePropertyId を載せる", () => {
    expect(codeOnly).toContain("singlePropertyId,");
  });

  it("物件の住所など物件の中身は読まない(IDだけ) — select は propertyId のみをallowlist)", () => {
    // 禁止パターンを列挙する形(not.toContain("address") / not.toMatch(/property:\s*\{\s*select/))
    // は、列挙し忘れた形で必ず抜ける(このリポジトリの durable ルール
    // `redaction-allowlist-not-pattern`)。`property: true` は Prisma で
    // 物件の全カラム(住所含む)を丸ごと返すが、"address" という文字列も
    // "property: { select" という形も含まないため、旧アサーションは
    // これを素通しする。
    //
    // ここでは逆に「許可されている形」だけを定義する: `propertyOwners.select`
    // の中身は `propertyId: true` **だけ**でなければ fail にする。
    // (`where: { property: propertyVisibilityScope } }` は select の外にある
    // scope filter で、Codex P1 (#139 finding) の正当な修正なのでここでは触れない。)
    const outer = extractUniqueBraceBlock(codeOnly, "propertyOwners: {");
    const selectBlock = extractUniqueBraceBlock(outer, "select: {");
    const inner = selectBlock.slice("select: {".length, -1);
    const keys = inner
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(keys).toEqual(["propertyId: true"]);
  });

  it("property:read が無いセッションには singlePropertyId を返さない(#139 finding)", () => {
    expect(codeOnly).toContain(
      'const hasPropertyRead = hasPermission(perms, "property", "read");',
    );
    // Codex P2 (#139 finding round 3): 三項演算子の**継続行インデント**まで
    // 固定していると、動作を変えないフォーマッタの整形だけでこのテストが
    // 赤くなる。「フォーマッタで壊れるテストは消される」ため、改行/空白は
    // 許容しつつ構造(hasPropertyRead を三項の条件にして pickSinglePropertyId
    // か null を選ぶ)だけを固定する。
    expect(codeOnly).toMatch(
      /const singlePropertyId = hasPropertyRead\s*\?\s*pickSinglePropertyId\(owner\.propertyOwners\)\s*:\s*null;/,
    );
  });

  it("field_staff の可視範囲スコープ(propertyVisibilityScopeWhere)を nested selection に適用する(#139 finding)", () => {
    expect(codeOnly).toContain(
      'import { propertyVisibilityScopeWhere } from "@/lib/property-list-query"',
    );
    expect(codeOnly).toContain(
      "const propertyVisibilityScope = propertyVisibilityScopeWhere(session);",
    );
    const block = extractUniqueBraceBlock(codeOnly, "propertyOwners: {");
    expect(block).toContain("propertyVisibilityScope");
    expect(block).toContain("where: { property: propertyVisibilityScope }");
  });
});
