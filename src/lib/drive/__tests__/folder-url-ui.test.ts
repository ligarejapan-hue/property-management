/**
 * ドライブ連携の「フォルダの URL を貼って開く」(画面)。vitest は env=node なので元のソースで確かめる。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(path.join(process.cwd(), "src/app/(dashboard)/admin/drive/page.tsx"), "utf8").replace(/\r\n/g, "\n");

describe("フォルダの URL を貼って開く", () => {
  it("URL の欄と「開く」がある・番号は folderIdFromUrl で取り出す", () => {
    expect(src).toContain('placeholder="フォルダの URL を貼って開く(共有ドライブの中も)"');
    expect(src).toContain("folderIdFromUrl(urlInput)");
  });

  it("いま開いているフォルダの URL を貼っても「読み込み中」で固まらない(もう開いている=何もしない・@codex #597 P2)", () => {
    const open = src.slice(src.indexOf("const openByUrl"), src.indexOf("const linkByFolder"));
    const guard = open.indexOf("if (id === parent)");
    const goCall = open.indexOf("go([{ id,");
    expect(guard).toBeGreaterThan(-1);
    expect(goCall).toBeGreaterThan(guard);
    expect(open.slice(guard, goCall)).toContain("return;");
  });

  it("URL で開いたフォルダそのものも紐づけられる(中にフォルダが無い物件フォルダでも・@codex #597 P2)", () => {
    expect(src).toContain("開いたフォルダ(このフォルダ自体を紐づける)");
    expect(src).toMatch(/selfRow && selfRow\.id === parent/);
    expect(src).toContain("folder={selfRow}");
    const route = readFileSync(path.join(process.cwd(), "src/app/api/admin/drive/folders/route.ts"), "utf8");
    expect(route).toContain("folderName: opened?.name ?? null, self,");
  });

  it("古い一文「往復は次の段で入ります」を残さない", () => {
    expect(src).not.toContain("書類の往復(複製・取り込み)は次の段で入ります");
  });
});
