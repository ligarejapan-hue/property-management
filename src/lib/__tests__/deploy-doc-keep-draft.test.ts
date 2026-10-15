// 別メニューへ移っても入力を消さない(第1段・第2段・2026-10)の説明が、アプリ内ガイド・マニュアル
// (public/docs)に入っていることと、画面の文言・消える条件が実装とずれていないことを固定する走査テスト。
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { DRAFT_MAX_AGE_MS } from "@/lib/drafts/draft-store";

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), "utf8");
}

const guideSrc = readRepoFile("public/docs/guide.html");
const manualSrc = readRepoFile("public/docs/manual.html");
const noticesSrc = readRepoFile("src/components/drafts/draft-notices.tsx");
const logoutSrc = readRepoFile("src/lib/notifications/logout.ts");
const excelTableSrc = readRepoFile("src/components/import/excel-lead-table.tsx");
const excelPageSrc = readRepoFile("src/app/(dashboard)/import/paste/excel/page.tsx");
const propertyPageSrc = readRepoFile("src/app/(dashboard)/properties/[id]/page.tsx");

describe("入力の途中をとっておく(2026-10): 資料の文言が画面と同じ", () => {
  it("戻ったときの帯の文言", () => {
    const banner = "前回の続きを表示しています";
    expect(noticesSrc).toContain(banner);
    expect(guideSrc).toContain(banner);
    expect(manualSrc).toContain(banner);
  });

  it("送っている途中で離れたときの案内", () => {
    const paste = "登録されたかどうかを物件一覧で確かめてください";
    const csv = "下の「取り込み履歴」で結果を確かめてください";
    expect(noticesSrc).toContain(paste);
    expect(noticesSrc).toContain(csv);
    expect(manualSrc).toContain(paste);
    expect(manualSrc).toContain(csv);
    for (const label of ["確かめたので続ける", "確かめたので閉じる"]) {
      expect(noticesSrc).toContain(label);
      expect(manualSrc).toContain(label);
    }
  });

  it("Excelは送っていた行だけ「分からない」になり、確かめて対象に戻す", () => {
    const badge = "登録されたか分かりません";
    const back = "確かめたので登録の対象に戻す";
    expect(excelTableSrc).toContain(badge);
    expect(excelTableSrc).toContain(back);
    expect(manualSrc).toContain(badge);
    expect(manualSrc).toContain(back);
    expect(guideSrc).toContain(badge);
  });

  it("消える条件(12時間・ログアウト)が実装と同じ", () => {
    expect(DRAFT_MAX_AGE_MS).toBe(12 * 60 * 60 * 1000);
    expect(logoutSrc).toContain("clearAllDrafts(");
    for (const src of [guideSrc, manualSrc]) {
      expect(src).toContain("12時間");
      expect(src).toContain("ログアウト");
    }
  });

  it("物件の編集は、ほかの方が保存すると続きを使えない", () => {
    const stale = "ほかの方が保存したため、入力途中の内容は使えませんでした。";
    expect(noticesSrc).toContain(stale);
    expect(propertyPageSrc).toContain("<DraftStaleNotice");
    expect(guideSrc).toContain(stale);
    expect(manualSrc).toContain(stale);
  });

  it("Excelは全部登録し終えても結果の表が残る(登録の後に控えを消さない)", () => {
    // 登録し終えた後も結果を控えに書き、消すのは「最初からやり直す」だけ。
    expect(excelPageSrc).toContain("sendingKey: null");
    expect(excelPageSrc.match(/draftSaver\.(discard|close)\(/g)).toEqual(["draftSaver.discard("]);
    for (const src of [guideSrc, manualSrc]) {
      expect(src).toContain("全部登録し終えても結果の表が残ります");
    }
  });

  it("大きすぎてとっておけないときの知らせを書いている", () => {
    const tooLarge = "このファイルは大きいため、別の画面へ移ると消えます";
    expect(noticesSrc).toContain("このファイルは大きいため");
    expect(noticesSrc).toContain("、別の画面へ移ると消えます");
    expect(guideSrc).toContain(tooLarge);
    expect(manualSrc).toContain(tooLarge);
  });

  it("とっておく場所に書けない(failed)ときは知らせが出ないことを書いている", () => {
    // writeDraft は "failed" を返し得るが、画面が知らせるのは too_large だけ。
    const storeSrc = readRepoFile("src/lib/drafts/draft-store.ts");
    expect(storeSrc).toContain('"ok" | "too_large" | "failed"');
    for (const src of [guideSrc, manualSrc]) expect(src).toContain("知らせが出ないまま残らないことがあります");
  });

  it("タブを複製すると続きも写る(設計書 §5.3)", () => {
    for (const src of [guideSrc, manualSrc]) expect(src).toContain("「タブを複製」");
  });

  it("新規物件登録・物件の編集の小窓は×で閉じると残り、キャンセルで閉じると消える(2026-10-15 発注者判断)", () => {
    // ×=控えを残す(close を呼ばない)/キャンセル=控えを消す(close)ことと、資料にそう書いてあることを照合する。
    const newModalSrc = readRepoFile("src/components/properties/new-property-modal.tsx");
    const editFormSrc = readRepoFile("src/components/properties/property-edit-form.tsx");
    expect(newModalSrc).toMatch(/const handleCloseKeepDraft = \(\) => \{\n\s*onClose\(\);\n\s*\};/);
    expect(newModalSrc).toMatch(/draft\.close\(\);\s*onClose\(\);/);
    expect(editFormSrc).toMatch(/const handleCloseKeepDraft = \(\) => \{\n\s*void lock\.release\(\);\n\s*onClose\(\);\n\s*\};/);
    expect(editFormSrc).toContain("editDraft.close();");
    for (const src of [guideSrc, manualSrc]) {
      expect(src).toContain("「×」で閉じると入力は残り");
      expect(src).toContain("「キャンセル」で閉じると入力は消えます");
      expect(src).toContain("小窓が開き直って続きが出ます");
      expect(src).not.toContain("×や「キャンセル」で閉じると");
    }
  });

  it("対象の6画面を両方の資料に書いている", () => {
    for (const name of ["新規物件登録", "物件の編集", "貼り付けて物件化", "謄本PDF取込", "受付帳CSV取込"]) {
      expect(guideSrc).toContain(name);
      expect(manualSrc).toContain(name);
    }
    expect(guideSrc).toContain("Excelからのまとめ取り込み");
    expect(manualSrc).toContain("Excelからのまとめ取り込み");
  });
});
