// 区分マンションの棟の自動つなぎ(段1〜3・2026-10)の説明が、アプリ内ガイド・マニュアル
// (public/docs)に入っていることと、画面の文言が実装とずれていないことを固定する走査テスト。
//
// 文言は実装の関数・定数から作って照合する(資料だけ古い文言のまま残るのを防ぐ)。
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { renamePropagateConfirmMessage } from "@/lib/building-link/rename";
import { typeChangeUnlinkConfirmMessage } from "@/lib/building-link/relink";

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

  it("種別を区分マンション以外へ変えるときの確認文は実装の関数と同じ形", () => {
    const msg = typeChangeUnlinkConfirmMessage({ id: "b1", name: "○○" }, "apartment_unit", "house");
    expect(msg).toBeTruthy();
    expect(manualSrc).toContain(msg as string);
    expect(guideSrc).toContain("種別を区分マンション以外に変えると棟から外します");
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

describe("棟の自動つなぎ: 受付帳CSVからの物件化は棟につながない(@codex P2)", () => {
  // 画面に出ている受付帳CSVの取込は物件名を入れず、棟の自動つなぎも呼ばない。
  // (棟につなぐ汎用CSV取込の画面は利用者には非表示。)取込側で棟につなぐようにしたら、資料もこのテストも直す。
  const receptionSrc = readRepoFile("src/app/api/import/reception-property/route.ts");

  it("受付帳CSVの取込は棟の自動つなぎを呼ばない", () => {
    expect(receptionSrc).not.toContain("applyBuildingLink");
  });

  it("マニュアルは「受付帳CSVでも棟へつなぐ」と書かず、つながらないことを案内する", () => {
    expect(manualSrc).not.toContain("受付帳CSVの取込でも、物件名から棟へつなぎます");
    expect(manualSrc).toContain("受付帳CSVから作った物件には物件名が入らないため、棟にはつながりません");
  });
});

describe("棟の自動つなぎ: 新しい棟ができる理由を3つとも案内する(@codex P2)", () => {
  // 「新しい棟として登録する」を選んだとき・町丁目が読めないときも新しく作る。
  // 「同じ名前の棟が無かったから」とだけ書くと、重複の棟を見落とす。
  it("手で選んだとき・町丁目が読めないときも書いている", () => {
    expect(manualSrc).toContain("新しい棟ができるのは次の3つのときです");
    expect(manualSrc).toContain("「新しい棟として登録する」を選んだ（同じ名前の棟があっても新しく作ります）");
    expect(noticeSrc).toContain("住所から町丁目を読み取れなかったため、新しい棟として作りました");
    expect(manualSrc).toContain("住所から町丁目を読み取れなかったため、新しい棟として作りました");
  });
});

describe("棟の自動つなぎ: 用語辞典に「棟」がある", () => {
  it("ガイドとマニュアルの両方", () => {
    expect(guideSrc).toContain("<tr><td>棟（とう）</td>");
    expect(manualSrc).toContain("<tr><td>棟（とう）</td>");
  });
});
