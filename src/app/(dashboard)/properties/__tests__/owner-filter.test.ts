/**
 * 物件一覧の「所有者で絞り込み」の配線テスト。
 * vitest は env=node(jsdom なし)のため、リポ慣行に従いソース文字列で検証する。
 * ⚠改行を LF に正規化してから比較する(手元 CRLF と CI で判定が変わるため)。
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, it, expect } from "vitest";

const src = readFileSync(resolve(__dirname, "../page.tsx"), "utf-8").replace(
  /\r\n/g,
  "\n",
);

describe("物件一覧の所有者絞り込み", () => {
  it("URL の ownerId を初期値として読む", () => {
    expect(src).toContain('sp.get("ownerId")');
  });

  it("API へ渡す条件に ownerId を載せる", () => {
    const build = src.match(
      /const buildFilterParams = useCallback\(\(\) => \{[\s\S]*?\n  \}, \[/,
    );
    expect(build).not.toBeNull();
    expect(build![0]).toContain("params.ownerId = ownerFilter");
  });

  it("URL 同期にも ownerId を載せる(再読み込みで絞り込みが消えない)", () => {
    expect(src).toContain('params.set("ownerId", ownerFilter)');
  });

  it("buildFilterParams の依存配列に ownerFilter が入っている(外すと古い値を見続けるstale closure)", () => {
    const build = src.match(
      /const buildFilterParams = useCallback\(\(\) => \{[\s\S]*?\n {2}\}, \[([^\]]*)\]\);/,
    );
    expect(build).not.toBeNull();
    const deps = build![1].split(",").map((s) => s.trim());
    expect(deps).toContain("ownerFilter");
  });

  it("URL 同期 useEffect の依存配列に ownerFilter が入っている(外すと ownerId が消えたURLのまま止まる)", () => {
    const effect = src.match(
      /router\.replace\(qs \? `\$\{pathname\}\?\$\{qs\}` : pathname, \{ scroll: false \}\);\n {2}\}, \[([^\]]*)\]\);/,
    );
    expect(effect).not.toBeNull();
    const deps = effect![1].split(",").map((s) => s.trim());
    expect(deps).toContain("ownerFilter");
  });

  it("「全フィルタをリセット」が ownerFilter も解除する", () => {
    const reset = src.match(
      /const handleResetFilters = \(\) => \{[\s\S]*?\n {2}\};/,
    );
    expect(reset).not.toBeNull();
    expect(reset![0]).toContain('setOwnerFilter("");');
  });

  it("hasActiveFilter が ownerFilter も見ている(所有者リンクで入っただけでリセットボタンが活性化する)", () => {
    const hasActive = src.match(/const hasActiveFilter =[\s\S]*?;/);
    expect(hasActive).not.toBeNull();
    expect(hasActive![0]).toContain("!!ownerFilter");
  });

  it("activeFilterCount が ownerFilter も数える", () => {
    const count = src.match(/const activeFilterCount = \[([\s\S]*?)\]/);
    expect(count).not.toBeNull();
    const deps = count![1].split(",").map((s) => s.trim());
    expect(deps).toContain("ownerFilter");
  });

  it("絞り込み中であることを画面に出し、解除できる", () => {
    expect(src).toContain("この所有者の物件だけを表示しています");
    expect(src).toContain("絞り込みを解除");
  });

  it("所有者の氏名・住所を URL にも画面の絞り込み表示にも出さない", () => {
    const chip = src.slice(
      src.indexOf("この所有者の物件だけを表示しています") - 400,
      src.indexOf("この所有者の物件だけを表示しています") + 400,
    );
    expect(chip).not.toContain("ownerName");
    expect(chip).not.toContain("ownerAddress");
  });
});

describe("mock モードの所有者絞り込み", () => {
  const client = readFileSync(
    resolve(__dirname, "../../../../lib/api-client.ts"),
    "utf-8",
  ).replace(/\r\n/g, "\n");

  it("mock データには所有者の紐づきが無いので空を返す(全件を他人の物件として見せない)", () => {
    // if とその中身を1つの正規表現でまとめて見る。別々に toContain すると
    // ファイル内の無関係な `filtered = [];` でも通ってしまう。
    expect(client).toMatch(
      /if \(params\.ownerId\) \{\s*\n\s*filtered = \[\];\s*\n\s*\}/,
    );
  });
});
