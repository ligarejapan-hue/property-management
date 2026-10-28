/**
 * 「ファイルを入れる」(2026-10-28 発注者決定・第2段)— 画面の作りをソースで確かめる(env=node)。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const page = read("src/app/(dashboard)/import/drop/page.tsx");

describe("ファイルを入れる", () => {
  it("題名は左メニューと同じ「ファイルを入れる」", () => {
    expect(page).toContain('title="ファイルを入れる"');
  });

  it("表は中身を読んで見分け、PDF は PDF のまま見分ける(どちらも保存しない口)", () => {
    expect(page).toContain("await readFileForImport(row.file)");
    expect(page).toContain("await detectDropSheet(read)");
    expect(page).toContain("await detectDropPdf(row.file)");
  });

  it("書類は受け取り箱へそのまま入れる・取り込みはボタンで1件ずつ進む(発注者決定)", () => {
    expect(page).toMatch(/if \(target === "document"\) \{\s*await sendToInbox\(row\);/);
    expect(page).toContain("router.push(HANDOFF_PATHS[target])");
    expect(page).toContain("putHandoff({ target, entry: row.entry })");
    expect(page).toContain("putHandoff({ target, file: row.file })");
  });

  it("決められない CSV は人が選ぶ(推測で取り込みへ回さない)", () => {
    expect(page).toContain('row.target === "unknown"');
    expect(page).toContain("受付帳として");
    expect(page).toContain("所有者の一覧として");
    expect(page).toContain("書類として受け取り箱へ");
  });

  it("⚠PDF の名前は出さない(枠の知らせ・表とも)", () => {
    expect(page).toContain("hideFileNames");
    expect(page).toContain("name: dropRowName(file, i)");
  });
});

describe("進んだ先の画面は、持ってきたファイルで始め、受け取ったら消す", () => {
  it.each([
    ["src/app/(dashboard)/import/registry-pdf/page.tsx", 'peekHandoffFile("registry_pdf")', 'clearHandoff("registry_pdf")'],
    ["src/app/(dashboard)/import/paste/page.tsx", 'peekHandoffFile("paste_pdf")', 'clearHandoff("paste_pdf")'],
    ["src/app/(dashboard)/import/paste/excel/page.tsx", 'peekHandoffFile("lead_excel")', 'clearHandoff("lead_excel")'],
    ["src/app/(dashboard)/import/page.tsx", 'peekHandoffEntry("reception")', 'clearHandoff("reception")'],
    ["src/app/(dashboard)/import/page.tsx", 'peekHandoffEntry("owner")', 'clearHandoff("owner")'],
  ])("%s", (file, peek, clear) => {
    const src = read(file);
    // 最初の描画で1回だけ読む(useState の初期化)・消すのは描き終えたあと(useEffect)。
    expect(src).toContain(`useState(() => ${peek})`);
    expect(src).toMatch(new RegExp(`useEffect\\(\\(\\) => \\{[\\s\\S]{0,80}${clear.replace(/[()]/g, "\\$&")}`));
  });

  it("取り込みの画面の、ファイルを入れる入り口の枠は外した(選び直しの枠だけ残る)", () => {
    for (const f of [
      "src/app/(dashboard)/import/page.tsx",
      "src/app/(dashboard)/import/paste/excel/page.tsx",
    ]) {
      expect(read(f)).not.toContain("<FileDropZone");
    }
    // 謄本・貼り付けは、控えから戻った確認の画面で同じ PDF を選び直す枠だけが残る。
    expect(read("src/app/(dashboard)/import/registry-pdf/page.tsx").match(/<FileDropZone\b/g)).toHaveLength(1);
    expect(read("src/app/(dashboard)/import/paste/page.tsx").match(/<FileDropZone\b/g)).toHaveLength(1);
  });
});
