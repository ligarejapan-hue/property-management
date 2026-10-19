/**
 * UIの統一 第3回(2026-10-19): 物件まわりに手書きの <button> を残さない。
 *
 * 設計書 docs/superpowers/specs/2026-10-19-ui-unify-motion-design.md §4。
 * 範囲 = src/components/properties と src/app/(dashboard)/properties の .tsx(テストを除く)。
 * 手書きの <button> は共通 Button へ置き換える。残してよいのは:
 *   - 開きタグに aria-pressed / role="tab" / data-motion="off" を持つもの(専用の見た目が仕様)
 *   - 開きタグに data-ui="raw" を持つもの = ボタンの形をしていない押せる面(写真の縮小表示・
 *     拡大表示の背景・行全体など)。共通 Button の余白・角丸が合わないため手書きのまま
 *     (全体の押した手応えはそのまま効く)。付けるときは直前に理由のコメントを1行書く
 *   - 下の FILE_ALLOW(ファイル丸ごと手書きのまま・理由付き)
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOTS = ["src/components/properties", "src/app/(dashboard)/properties"];

const FILE_ALLOW = new Set([
  // 謄本の実況パネル: 根に data-motion="off"(課金中の中止などは沈ませない・設計書 §2)
  "src/components/properties/registry-live-panel.tsx",
]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "__tests__" ? [] : walk(p);
    return p.endsWith(".tsx") ? [p] : [];
  });
}

/** `<button` から、波かっこ・引用符の外にある最初の `>` までを開きタグとして返す。 */
function openingTags(src: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}(?![\\w-])`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 0;
    let quote: string | null = null;
    let i = m.index + m[0].length;
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
    out.push(src.slice(m.index, i + 1));
  }
  return out;
}

const isAllowedTag = (t: string) =>
  /\baria-pressed\b/.test(t) ||
  /role="tab"/.test(t) ||
  /data-motion="off"/.test(t) ||
  /data-ui="raw"/.test(t);

describe("物件まわりの手書きボタン(UIの統一 第3回)", () => {
  const files = ROOTS.flatMap((r) => walk(join(process.cwd(), r)));
  const rel = (f: string) => relative(process.cwd(), f).replace(/\\/g, "/");

  it("走査の範囲にファイルがある(パスの書き間違いで空振りしない)", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("開きタグの切り出しは => や文字列の中の > で止まらない", () => {
    const tags = openingTags(
      `<button onClick={() => a > b && go(">")} className="x">押す</button><Button>`,
      "button",
    );
    expect(tags).toEqual([`<button onClick={() => a > b && go(">")} className="x">`]);
  });

  it("手書きの <button> が残っていない(許可は aria-pressed・role=tab・data-motion=off・理由付きファイル)", () => {
    const offenders = files
      .filter((f) => !FILE_ALLOW.has(rel(f)))
      .flatMap((f) => {
        const src = readFileSync(f, "utf8").replace(/\r\n/g, "\n");
        const n = openingTags(src, "button").filter((t) => !isAllowedTag(t)).length;
        return n > 0 ? [`${rel(f)}: ${n}`] : [];
      });
    expect(offenders, "共通 Button(@/components/ui/button)へ置き換える").toEqual([]);
  });

  it('data-ui="raw" には直前2行以内に理由のコメント(data-ui=raw: …)がある', () => {
    const missing = files.flatMap((f) => {
      const lines = readFileSync(f, "utf8").replace(/\r\n/g, "\n").split("\n");
      return lines.flatMap((l, i) =>
        l.includes('data-ui="raw"') &&
        !lines.slice(Math.max(0, i - 3), i + 1).some((p) => /data-ui=raw:/.test(p))
          ? [`${rel(f)}:${i + 1}`]
          : [],
      );
    });
    expect(missing).toEqual([]);
  });

  it("★文中・値の欄の下線リンクは Button にしない(余白で文がずれる・提出前レビュー指摘)", () => {
    const cases: [string, string][] = [
      // marker はコメントに出てこない、そのボタンだけの属性にする
      ["src/components/properties/photo-tab-building-hint.tsx", "onClick={onEditProperty}"],
      ["src/app/(dashboard)/properties/[id]/page.tsx", 'data-testid="building-name-connect"'],
      ["src/app/(dashboard)/properties/[id]/page.tsx", "onClick={onOpenAttachments}"],
    ];
    for (const [file, marker] of cases) {
      const src = readFileSync(join(process.cwd(), file), "utf8").replace(/\r\n/g, "\n");
      const at = src.indexOf(marker);
      expect(at, `${file} に ${marker} がある`).toBeGreaterThan(-1);
      // marker を囲む直近の開きタグ(<button か <Button)
      const open = Math.max(src.lastIndexOf("<button", at), src.lastIndexOf("<Button", at));
      expect(src.startsWith("<button", open), `${file} の ${marker} は手書きの <button>`).toBe(true);
      const tag = openingTags(src.slice(open), "button")[0] ?? "";
      expect(tag, `${file} の ${marker}`).toMatch(/data-ui="raw"/);
      expect(tag).toMatch(/underline/);
    }
  });
});
