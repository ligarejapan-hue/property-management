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

  it("useSearchParams を使う本体は Suspense で包む", () => {
    expect(SRC).toMatch(/<Suspense[\s\S]*<DriveAdminPageInner \/>[\s\S]*<\/Suspense>/);
  });
});
