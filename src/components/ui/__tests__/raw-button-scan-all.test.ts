/**
 * UIの統一 第7回(最終回・2026-10-21): サイト全体(src 配下の .tsx)に手書きの <button> を残さない。
 *
 * 設計書 docs/superpowers/specs/2026-10-19-ui-unify-motion-design.md §4。
 * 第3〜6回の走査テストは画面の群ごと。ここでは src 全体を見て、新しく足した画面の取りこぼしも止める。
 * 手書きの <button> は共通 Button へ置き換える。残してよいのは:
 *   - 開きタグに aria-pressed / role="tab" / data-motion="off" を持つもの(専用の見た目が仕様)
 *   - 開きタグに data-ui="raw" を持つもの = ボタンの形をしていない押せる面(行全体・縮小表示・
 *     メニューの1項目・通知の1件・閉じる×など)。付けるときは直前に理由のコメントを1行書く
 *   - 下の FILE_ALLOW(ファイル丸ごと手書きのまま・理由付き)
 * 判定の部品は第3回の raw-button-scan-properties.test.ts と同じ。
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOTS = ["src"];

const FILE_ALLOW = new Set<string>([
  // 共通 Button そのもの(中身が <button>)
  "src/components/ui/button.tsx",
  // 説明のコメントに「<button> をカードにするときは」と書いてあるだけで、ボタンは無い
  "src/components/ui/card.tsx",
  // 開発中だけ出す色の調整道具(本番の画面には出ない)
  "src/components/dev/theme-tuner/ThemeTunerPanel.tsx",
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

describe("サイト全体の手書きボタン(UIの統一 第7回)", () => {
  const files = ROOTS.flatMap((r) => walk(join(process.cwd(), r)));
  const rel = (f: string) => relative(process.cwd(), f).replace(/\\/g, "/");

  it("走査の範囲にファイルがある(パスの書き間違いで空振りしない)", () => {
    expect(files.length).toBeGreaterThan(150);
  });

  it("FILE_ALLOW のファイルが実在する(消えた・移ったファイルを許可に残さない)", () => {
    const names = new Set(files.map(rel));
    expect([...FILE_ALLOW].filter((f) => !names.has(f))).toEqual([]);
  });

  it("手書きの <button> が残っていない(許可は aria-pressed・role=tab・data-motion=off・data-ui=raw)", () => {
    const offenders = files
      .filter((f) => !FILE_ALLOW.has(rel(f)))
      .flatMap((f) => {
        const src = readFileSync(f, "utf8").replace(/\r\n/g, "\n");
        const n = openingTags(src, "button").filter((t) => !isAllowedTag(t)).length;
        return n > 0 ? [`${rel(f)}: ${n}`] : [];
      });
    expect(offenders, "共通 Button(@/components/ui/button)へ置き換える").toEqual([]);
  });

  it("共通 Button の className に置き場所(absolute・fixed・sticky)を渡さない(Button の relative に負けて動く)", () => {
    const bad = files.flatMap((f) => {
      const src = readFileSync(f, "utf8").replace(/\r\n/g, "\n");
      return openingTags(src, "Button")
        .filter((t) => /className=(?:"|\{`)[^"`]*\b(?:absolute|fixed|sticky)\b/.test(t))
        .map(() => rel(f));
    });
    expect(bad, "外側の div に置き場所を持たせる").toEqual([]);
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
});
