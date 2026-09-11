/**
 * 補正候補画面の「物件」列がリンクになっていることの配線テスト。
 * 件数からリンク先を決める判定は resolveOwnerPropertyLink の単体テストが担保する。
 * ⚠改行を LF に正規化してから比較する。
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, it, expect } from "vitest";

const page = readFileSync(resolve(__dirname, "../page.tsx"), "utf-8").replace(
  /\r\n/g,
  "\n",
);
const cell = readFileSync(
  resolve(__dirname, "../../../../../../components/owners/owner-property-count-cell.tsx"),
  "utf-8",
).replace(/\r\n/g, "\n");

/**
 * コメントを剥がしてから走査する。剥がさないと、marker や条件式の文字列を
 * "たまたま含むだけの説明コメント" を実コードと取り違える
 * (このリポジトリで実際に起きた事故と同型)。
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
}

/** marker(末尾が "{") から対応する閉じ "}" までを波かっこの深さで取り出す。 */
function extractBraceBlock(text: string, marker: string): string {
  const start = text.indexOf(marker);
  if (start === -1) throw new Error(`marker not found: ${marker}`);
  let depth = 1;
  for (let i = start + marker.length; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces after marker: ${marker}`);
}

const cellCode = stripComments(cell);

describe("補正候補画面の物件リンク", () => {
  it("物件件数のセルを共通部品にしている(2箇所とも)", () => {
    const uses = page.match(/<OwnerPropertyCountCell/g) ?? [];
    expect(uses.length).toBe(2);
  });

  it("両方の呼び出しが propertyLinkAvailable を渡している(P2 #139 fallout)", () => {
    // summary.propertyLinkAvailable=false のとき「物件」列のリンクを消す修正。
    // 呼び出し側がこの flag を渡し忘れると、property:read の無いユーザーに
    // 必ず 403 になるリンクが復活してしまう。渡し忘れをここで固定する。
    const calls = page.match(/<OwnerPropertyCountCell\b[\s\S]*?\/>/g) ?? [];
    expect(calls.length).toBe(2);
    for (const call of calls) {
      expect(call, `propertyLinkAvailable が渡っていない呼び出し: ${call}`).toContain(
        "propertyLinkAvailable=",
      );
    }
  });

  it("両方の呼び出しが hasReachableProperty を渡している(P2 #139 二次回帰)", () => {
    // 件数は正だが可視範囲スコープ内の紐づきが0件のとき、この flag を
    // 渡し忘れると壊れたデフォルト(undefined→falsy 扱い)でリンクの有無が
    // 決まってしまう。呼び出し側の渡し忘れをここで固定する。
    const calls = page.match(/<OwnerPropertyCountCell\b[\s\S]*?\/>/g) ?? [];
    expect(calls.length).toBe(2);
    for (const call of calls) {
      expect(
        call,
        `hasReachableProperty が渡っていない呼び出し: ${call}`,
      ).toContain("hasReachableProperty=");
    }
  });

  it("部品を import している", () => {
    expect(page).toContain(
      'import { OwnerPropertyCountCell } from "@/components/owners/owner-property-count-cell"',
    );
  });

  it("件数を描くのは共通部品だけ(生の描画も分岐も残っていない)", () => {
    // 旧実装の「0件だけ橙色」の分岐が JSX に残っていないこと
    expect(page).not.toContain("c.propertyOwnerCount === 0");
    // propertyOwnerCount の登場は「型宣言」「並べ替えの比較」「部品への受け渡し」だけ。
    // 危険なものを除く書き方ではなく、安全なものだけを許す書き方にする(許可リスト方式)。
    const lines = page
      .split("\n")
      .filter((l) => l.includes("propertyOwnerCount"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const allowed =
        /propertyOwnerCount\??:\s*number;/.test(line) ||
        /[ab]\.propertyOwnerCount/.test(line) ||
        /count=\{[cm]\.propertyOwnerCount\}/.test(line);
      expect(allowed, `想定外の使い方: ${line.trim()}`).toBe(true);
    }
  });

  it("住所なしタブの 0 件は今までどおり橙色で目立たせる", () => {
    expect(page).toContain('zeroClassName="font-medium text-orange-600"');
  });
});

describe("物件件数セルの部品", () => {
  it("リンク先の判定は純関数に任せる", () => {
    expect(cell).toContain(
      'import { resolveOwnerPropertyLink } from "@/lib/owner-property-link"',
    );
    expect(cell).toContain("resolveOwnerPropertyLink(");
  });

  it("none のときはリンクにしない", () => {
    expect(cell).toContain('link.kind === "none"');
  });

  it("hasReachableProperty を純関数へそのまま渡す(P2 #139 二次回帰)", () => {
    const callBlock = extractBraceBlock(cellCode, "resolveOwnerPropertyLink({");
    expect(callBlock).toContain("hasReachableProperty");
  });

  it("行き先が分かる説明を付ける(平易な日本語)", () => {
    expect(cell).toContain("この物件の基本情報を開く");
    expect(cell).toContain("この所有者の物件を一覧で見る");
  });
  it("橙色は『0件』という**データ**の主張。リンクが無いだけの行には付けない", () => {
    // link.kind === "none" は「0件」と「property:read が無い」の両方で起きる。
    // 橙を link.kind に紐づけると、物件を持つ所有者が削除候補の色で出てしまう。
    const noneBlock = extractBraceBlock(cellCode, 'if (link.kind === "none") {');
    // 橙の選択は count で決めること。
    expect(noneBlock).toMatch(/count\s*<=\s*0\s*\?[\s\S]*zeroClassName/);
    // zeroClassName が count のガードの外で使われていないこと(登場は1回だけ)。
    expect(noneBlock.split("zeroClassName").length - 1).toBe(1);
  });

  it("リンクが無くても件数そのものは必ず描く", () => {
    const noneBlock = extractBraceBlock(cellCode, 'if (link.kind === "none") {');
    expect(noneBlock).toContain("{count}");
  });
});
