/**
 * 管理 › ドライブ連携の画面(ソースの決まりごと)。vitest は node 環境で画面の操作を動かせないので、
 * 守りたい書き方をソース文字列で固定する。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(process.cwd(), "src/app/(dashboard)/admin/drive/page.tsx"), "utf8").replace(/\r\n/g, "\n");

describe("ドライブ連携の画面", () => {
  it("★フォルダを移るとき(go)に名前の絞り込みを外す(@codex #577 P2)", () => {
    const go = /const go = \(next: Crumb\[\]\) => \{[\s\S]*?\n {2}\};/.exec(SRC)?.[0] ?? "";
    expect(go).toContain('setQ("")');
    expect(go).toContain("setCrumbs(next)");
  });

  it("フォルダの移動はすべて go() を通す(setCrumbs を直接呼ばない)", () => {
    const direct = SRC.split("\n").filter((l) => l.includes("setCrumbs(") && !l.includes("const [crumbs, setCrumbs]"));
    expect(direct).toEqual(["    setCrumbs(next);"]);
  });

  it("★同じフォルダへの移動(今のパンくず・選択中のタブ)で、絞り込みも無ければ何もしない(読み込み中のまま固まらない・@codex #577 R2)", () => {
    const go = /const go = \(next: Crumb\[\]\) => \{[\s\S]*?\n {2}\};/.exec(SRC)?.[0] ?? "";
    expect(go).toMatch(/const same = next\.length === crumbs\.length && next\[next\.length - 1\]\.id === parent;/);
    expect(go).toMatch(/if \(same && q === ""\) return;/);
    // 早めの return は、読み込み中の印を立てる前
    expect(go.indexOf("return;")).toBeLessThan(go.indexOf("setLoading(true)"));
  });

  it("★紐づけ・外しのあとはフォルダの一覧も読み直す(rev)・紐づけ済みの表示は今の紐づけ一覧から決める(@codex #577 R2)", () => {
    expect(SRC).toMatch(/useEffect\(\(\) => \{\n\s+void load\(false\);\n\s+\}, \[load, rev\]\);/);
    expect(SRC).toMatch(/setLinksRev\(\(v\) => v \+ 1\)/);
    // 行の「紐づけ済」は読み込んだ時点の folder.linkedProperty ではなく、今の links から
    expect(SRC).not.toMatch(/folder\.linkedProperty \|\| linked/);
    expect(SRC).toMatch(/linkedTo=\{linkByFolder\.get\(f\.id\)\?\.property \?\? null\}/);
  });

  it("★古いフォルダ一覧の応答は捨てる(移動・絞り込み・さらに読むが重なっても今の場所の一覧だけ出す・@codex #577 R3)", () => {
    const load = /const load = useCallback\([\s\S]*?\n {2}\);/.exec(SRC)?.[0] ?? "";
    expect(load).toMatch(/const gen = \+\+loadGen\.current;/);
    // await のあと、状態を変える前に世代を確かめる
    const afterAwait = load.slice(load.indexOf("await listDriveFolders"));
    expect(afterAwait).toMatch(/if \(gen !== loadGen\.current\) return;/);
    expect(afterAwait.indexOf("if (gen !== loadGen.current) return;")).toBeLessThan(afterAwait.indexOf("setRows("));
    expect(load).toMatch(/finally \{\n\s+if \(gen === loadGen\.current\) setLoading\(false\);/);
  });

  it("useSearchParams を使う本体は Suspense で包む", () => {
    expect(SRC).toMatch(/<Suspense[\s\S]*<DriveAdminPageInner \/>[\s\S]*<\/Suspense>/);
  });
});
