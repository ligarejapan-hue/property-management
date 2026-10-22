/**
 * 実機確認 2026-10-22(別の Claude がブラウザで本番を見た報告・2回目)で分かった小さな直し。
 * 画面の部品は hooks 込みのクライアント部品で SSR できないため、ソース文字列で守る。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

/** `<button`/`<Button` から、波かっこ・引用符の外にある最初の `>` までの開きタグ。 */
function openingTag(src: string, at: number): string {
  const open = Math.max(src.lastIndexOf("<button", at), src.lastIndexOf("<Button", at));
  expect(open).toBeGreaterThan(-1);
  let depth = 0;
  let quote: string | null = null;
  let i = open + 1;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) break;
  }
  return src.slice(open, i + 1);
}

describe("物件の所有者タブ「別の所有者に付け替える」は共通 Button の補助(灰色の枠)(220)", () => {
  const src = read("src/app/(dashboard)/properties/[id]/page.tsx");
  const tag = openingTag(src, src.indexOf('title="この所有者を、別の所有者に付け替える"'));

  it("共通 Button の secondary・sm(手書きの琥珀ボタンではない)", () => {
    expect(tag.startsWith("<Button")).toBe(true);
    expect(tag).toMatch(/variant="secondary"/);
    expect(tag).toMatch(/size="sm"/);
    expect(tag).not.toMatch(/data-ui="raw"/);
    expect(tag).not.toMatch(/amber/);
  });

  it("編集ボタンが無い役割では右寄せ(ml-auto)のまま", () => {
    expect(tag).toMatch(/editAllowed \? "" : "ml-auto"/);
  });
});

describe("反響の受付の小窓「閉じる」は枠なし(ghost)(220 の気づき)", () => {
  const src = read("src/components/agent-inquiry/inquiry-detail.tsx");

  it("「閉じる」の Button は全部 variant=\"ghost\"", () => {
    // 文言そのものが「閉じる」のボタンだけ(コメントや「…を閉じる」は対象外)
    const tags: string[] = [];
    const re = />\s*閉じる\s*</g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) tags.push(openingTag(src, m.index));
    expect(tags.length).toBeGreaterThanOrEqual(3);
    for (const t of tags) expect(t, t).toMatch(/variant="ghost"/);
  });
});

describe("ヘルプ「CSV出力ルール」は今の置き場所(「出力 ▾」の中)を案内する(189 の気づき)", () => {
  const src = read("src/app/(dashboard)/help/page.tsx");

  it("「出力 ▾」の中の「CSV出力」から、と書いてある", () => {
    expect(src).toMatch(/「出力 ▾」の中の「CSV出力」/);
  });

  it("古い「物件一覧画面の『CSV出力』ボタンから」は残っていない", () => {
    expect(src).not.toMatch(/<\/RoleLink>の「CSV出力」ボタンから/);
  });
});
