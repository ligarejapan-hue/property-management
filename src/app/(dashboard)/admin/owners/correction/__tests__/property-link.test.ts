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

describe("補正候補画面の物件リンク", () => {
  it("物件件数のセルを共通部品にしている(2箇所とも)", () => {
    const uses = page.match(/<OwnerPropertyCountCell/g) ?? [];
    expect(uses.length).toBe(2);
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

  it("行き先が分かる説明を付ける(平易な日本語)", () => {
    expect(cell).toContain("この物件の基本情報を開く");
    expect(cell).toContain("この所有者の物件を一覧で見る");
  });
});
