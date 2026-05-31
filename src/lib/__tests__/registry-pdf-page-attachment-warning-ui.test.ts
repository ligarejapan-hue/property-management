/**
 * registry-pdf import page (A-2b/P1): server response の top-level `warning` を
 * 結果画面に表示することの UI source-assertion テスト。
 *
 * 背景: 謄本PDF保存失敗 / Mode B でアクセス不可物件に match した場合、取込本体は
 * 成功しても PDF が保存されない。サーバーは top-level `warning` を返すが、画面が
 * `parsed.warnings` しか表示していなかったため、ユーザーが気づけなかった（Codex 指摘）。
 *
 * 既存の registry-pdf page UI テスト（scanned-banner / paste-assist）と同じ
 * source-assertion 方式に合わせる。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const pageSrc = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/(dashboard)/import/registry-pdf/page.tsx",
  ),
  "utf8",
);

describe("import/registry-pdf page: top-level attachment warning の表示", () => {
  it("ImportResult 型に top-level warning を持つ（client response 型に追加）", () => {
    expect(pageSrc).toMatch(
      /interface ImportResult \{[\s\S]*?warning\?: string;[\s\S]*?\n\}/,
    );
  });

  it("result 画面で top-level result.warning を条件表示し、文言を描画する", () => {
    // result.warning がある時だけ描画する条件分岐
    expect(pageSrc).toMatch(/result\.warning && \(/);
    // warning 文字列そのものを描画している（タグ間に展開）
    expect(pageSrc).toMatch(/>\{result\.warning\}</);
    // 識別用 data-testid / role=alert を持つ
    expect(pageSrc).toMatch(/data-testid=("|')import-attachment-warning\1/);
    expect(pageSrc).toMatch(/role=("|')alert\1/);
  });

  it("成功表示（取込完了）は維持されている（注意があっても成功は消さない）", () => {
    expect(pageSrc).toMatch(/取込が完了しました/);
  });

  it("既存の parsed.warnings 表示を維持している", () => {
    expect(pageSrc).toMatch(/result\.parsed\.warnings\.length > 0/);
    expect(pageSrc).toMatch(/result\.parsed\.warnings\.map\(/);
  });

  it("top-level warning と parsed.warnings は独立条件（両方同時に出せる）", () => {
    // それぞれ独立した条件式 → 両方 true なら両方描画される
    expect(pageSrc).toMatch(/\{\s*result\.warning && \(/);
    expect(pageSrc).toMatch(/\{\s*result\.parsed\.warnings\.length > 0 && \(/);
  });
});
