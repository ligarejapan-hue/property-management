// 区分マンションの棟の自動つなぎ(段1〜3・2026-10)の説明が、アプリ内ガイド・マニュアル
// (public/docs)に入っていることと、画面の文言が実装とずれていないことを固定する走査テスト。
//
// 文言は実装の関数・定数から作って照合する(資料だけ古い文言のまま残るのを防ぐ)。
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { renamePropagateConfirmMessage } from "@/lib/building-link/rename";

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), "utf8");
}

const guideSrc = readRepoFile("public/docs/guide.html");
const manualSrc = readRepoFile("public/docs/manual.html");
const comboboxSrc = readRepoFile("src/components/buildings/building-name-combobox.tsx");
const noticeSrc = readRepoFile("src/lib/building-link/notice.ts");
const hintSrc = readRepoFile("src/components/properties/photo-tab-building-hint.tsx");
const buildingRouteSrc = readRepoFile("src/app/api/buildings/[id]/route.ts");
const sidebarSrc = readRepoFile("src/components/layout/sidebar-model.tsx");

describe("棟の自動つなぎ: 画面の文言が実装と同じ", () => {
  it("候補の一番下「新しい棟として登録する」", () => {
    expect(comboboxSrc).toContain("新しい棟として登録する");
    expect(guideSrc).toContain("新しい棟として登録する");
    expect(manualSrc).toContain("新しい棟として登録する");
  });

  it("新しく作ったときの知らせ「正式な表記か確認してください」と「棟の画面を開く」", () => {
    expect(noticeSrc).toContain("を新しく作りました。正式な表記か確認してください");
    expect(noticeSrc).toContain("棟の画面を開く");
    expect(manualSrc).toContain("を新しく作りました。正式な表記か確認してください");
    expect(manualSrc).toContain("棟の画面を開く");
  });

  it("棟の名前を直すときの確認文は実装の関数と同じ形", () => {
    // 資料では件数と名前を「N」「新しい名前」で書く。
    const msg = renamePropagateConfirmMessage("古い名前", "新しい名前", 3)?.replace("3", "N");
    expect(msg).toBeTruthy();
    expect(guideSrc).toContain(msg as string);
    expect(manualSrc).toContain(msg as string);
  });

  it("編集中で止まるときの文言", () => {
    expect(buildingRouteSrc).toContain("件が編集中のため、名前を全部屋に反映できません");
    expect(manualSrc).toContain("件が編集中のため、名前を全部屋に反映できません");
  });

  it("写真タブの案内(棟なしのボタン・それ以外の文)", () => {
    expect(hintSrc).toContain("物件名を入れる");
    expect(hintSrc).toContain("この物件の写真です。");
    expect(manualSrc).toContain("物件名を入れる");
    expect(manualSrc).toContain("この物件の写真です。");
  });

  it("棟の画面へのメニュー名「マンション棟」", () => {
    expect(sidebarSrc).toContain('label: "マンション棟"');
    expect(manualSrc).toContain("メニューの「マンション棟」");
  });
});

describe("棟の自動つなぎ: 用語辞典に「棟」がある", () => {
  it("ガイドとマニュアルの両方", () => {
    expect(guideSrc).toContain("<tr><td>棟（とう）</td>");
    expect(manualSrc).toContain("<tr><td>棟（とう）</td>");
  });
});
