// Task 12(査定申込の通知メール): 反映手順(docs/deploy.md)とアプリ内複製(public/docs/guide.html)に
// 新機能の記載が入っていることを固定する走査テスト。
//
// 背景: このリリースは新規 npm 依存(nodemailer)・追加のみの migration
// (20260918100000_add_mail_config_and_inquiry_notify)・管理者の反映後の設定手順(Xserver の
// メールボックス値・465/SSL・テスト送信・利用者一覧の「通知」)・迷惑メール対策(SPF/DKIM)を伴う。
// これらは docs/deploy.md に記載しないと反映担当者が気づけない(コード自体はコミット済みで動くが、
// 設定を入れなければ通知は常に「no_recipients」で失敗し続ける)。
//
// public/docs/guide.html はアプリ内(サイドバー最下部「資料」)から誰でも開けるガイドの複製で、
// 「査定の申込」画面の見方(通知できていません・再送)が載っていないと、非技術者の利用者が
// 画面の意味を理解できない。
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), "utf8");
}

const deploySrc = readRepoFile("docs/deploy.md");
const guideSrc = readRepoFile("public/docs/guide.html");
const manualSrc = readRepoFile("public/docs/manual.html");

describe("docs/deploy.md: 申込の通知メールの反映手順", () => {
  it("新規依存 nodemailer に触れている", () => {
    expect(deploySrc).toContain("nodemailer");
  });

  it("Xserver の接続方式(465)に触れている", () => {
    expect(deploySrc).toContain("465");
  });

  it("迷惑メール対策(SPF/DKIM)に触れている", () => {
    expect(deploySrc).toContain("SPF");
    expect(deploySrc).toContain("DKIM");
  });

  it("管理者の設定画面名(メール送信設定)に触れている", () => {
    expect(deploySrc).toContain("メール送信設定");
  });

  it("利用者ごとの通知先の設定に触れている", () => {
    expect(deploySrc).toContain("通知");
  });

  it("追加のみの migration 名を明記している", () => {
    expect(deploySrc).toContain("20260918100000_add_mail_config_and_inquiry_notify");
  });

  it("この節は「売却DM 公開LP「査定申込フォーム」」の節より後に置かれている", () => {
    const formIdx = deploySrc.indexOf("売却DM 公開LP「査定申込フォーム」");
    const notifyIdx = deploySrc.indexOf("売却DM 申込の通知メール");
    expect(formIdx).toBeGreaterThan(-1);
    expect(notifyIdx).toBeGreaterThan(formIdx);
  });

  it("パスワードを資料やチャットに書かない旨の注意がある", () => {
    expect(deploySrc).toContain("パスワード");
    expect(deploySrc).toMatch(/パスワード.*(書かない|入力しない)|書かない.*パスワード/);
  });

  // fix round 1 (Important #2): resolveRecipients (src/lib/sale-dm-letter/inquiry-notify.ts) は
  // field_staff を担当外の物件で完全に除外する(通知の宛先一覧に入れない)。「最小限の内容が届く」
  // という誤記載(=実際には何も届かない)に戻らないよう固定する。
  it("現場担当者は担当外の物件では通知が一切届かないと明記している(最小限が届くという誤りに戻さない)", () => {
    expect(deploySrc).toContain("現場担当者(field_staff)は、自分が作成または担当している物件の申込についてのみ通知の対象になる");
    expect(deploySrc).toContain("担当外の物件については、最小限の内容であっても通知が届かない");
    expect(deploySrc).not.toContain("現場担当者が担当外の物件で受け取る通知には町名までの所在などの最小限だけが載る");
  });

  // fix round 1 (Minor #3): 通知の成功は画面上のラベルではなく「失敗の帯が出ない」ことでしか
  // 分からない(「送付済み」という固有の状態ラベルは無い)。
  it("通知成功を「送付済み」という画面ラベルであるかのように書いていない", () => {
    expect(deploySrc).not.toContain("全員へ送り終えた申込は「送付済み」");
  });
});

describe("public/docs/guide.html: 「査定の申込」画面の説明", () => {
  it("<body> タグを含む(wrap で欠落させない)", () => {
    expect(guideSrc).toMatch(/<body>/);
    expect(guideSrc).toMatch(/<\/body>/);
  });

  it("doctype/head/main の構造が保たれている", () => {
    expect(guideSrc.trim().startsWith("<!doctype html>")).toBe(true);
    expect(guideSrc).toContain("<head>");
    expect(guideSrc).toContain("<main>");
    expect(guideSrc).toContain("</main>");
    expect(guideSrc).toContain("</html>");
  });

  it("「査定の申込」画面に触れている", () => {
    expect(guideSrc).toContain("査定の申込");
  });

  it("通知の受け取り設定(通知)に触れている", () => {
    expect(guideSrc).toContain("通知");
  });

  it("送信できなかった申込の表示(通知できていません・再送)に触れている", () => {
    expect(guideSrc).toContain("通知できていません");
    expect(guideSrc).toContain("再送");
  });

  it("次の段階で追加予定という古い記載が残っていない", () => {
    expect(guideSrc).not.toContain("申込が届いたことをメールで知らせる仕組みは次の段階で追加予定");
  });
});

describe("public/docs/manual.html: 通知の使い方説明", () => {
  it("<body> タグを含む(wrap で欠落させない)", () => {
    expect(manualSrc).toMatch(/<body>/);
    expect(manualSrc).toMatch(/<\/body>/);
  });

  it("doctype/head の構造が保たれている", () => {
    expect(manualSrc.trim().startsWith("<!doctype html>")).toBe(true);
    expect(manualSrc).toContain("<head>");
    expect(manualSrc).toContain("</html>");
  });

  it("「査定の申込」画面と、通知できていません・再送に触れている", () => {
    expect(manualSrc).toContain("査定の申込");
    expect(manualSrc).toContain("通知できていません");
    expect(manualSrc).toContain("再送");
  });

  it("管理者向けの「メール送信設定」画面に触れている", () => {
    expect(manualSrc).toContain("メール送信設定");
  });

  it("次の段階で追加予定という古い記載が残っていない", () => {
    expect(manualSrc).not.toContain("次の段階で追加予定");
  });
});

// fix round 1 (Important #1): 「メール送信設定」はサイドバー「DM」グループにあり(sidebar-model.tsx)、
// 「システム管理」配下ではない。この2語が同じ説明行に同居していたら誤記載が戻ったサインとする。
describe("Task 12 fix round 1: 「メール送信設定」の設置場所(サイドバー「DM」グループ)", () => {
  it("guide.html の説明行は「メール送信設定」を「システム管理」の配下として書いていない", () => {
    const offending = guideSrc
      .split("\n")
      .filter((line) => line.includes("メール送信設定") && line.includes("システム管理"));
    expect(offending).toEqual([]);
  });

  it("manual.html の説明行は「メール送信設定」を「システム管理」の配下として書いていない", () => {
    const offending = manualSrc
      .split("\n")
      .filter((line) => line.includes("メール送信設定") && line.includes("システム管理"));
    expect(offending).toEqual([]);
  });
});

// fix round 1 (Important #2): guide.html 側も、現場担当者が担当外の物件では通知そのものを
// 受け取らない(最小限の内容ですら届かない)ことを明記する。
describe("Task 12 fix round 1: guide.html の現場担当者の通知範囲", () => {
  it("担当外の物件では通知そのものが届かないと明記している", () => {
    expect(guideSrc).toContain("現場担当者は、自分が作成または担当している物件の申込についてのみ通知が届きます");
    expect(guideSrc).toContain("担当外の物件については、通知そのものが届きません");
  });

  it("「担当外の物件でも最小限の内容が届く」という誤りに戻っていない", () => {
    expect(guideSrc).not.toContain("担当外の物件について現場担当者が受け取る通知には、町名までの所在など最小限だけが載ります");
  });
});

// 2026-10-03: 申込者への受付メール(スイッチ既定OFF)と通知 段階2(次回対応・査定の申込のお知らせ)が
// 本番に入ったあとも、資料に「自動返信は無い」「次回対応の知らせはこれから」が残っていた。
describe("反映済みの機能を「無い・これから」と書いていない", () => {
  it.each([
    ["guide", () => guideSrc],
    ["manual", () => manualSrc],
  ])("%s.html は申込者への受付メールを「無い」と書かず、ONにしたときだけ送ると書く", (_name, src) => {
    expect(src()).not.toContain("自動返信メールはありません");
    expect(src()).toContain("でONにしたときだけ送ります");
  });

  it.each([
    ["guide", () => guideSrc],
    ["manual", () => manualSrc],
  ])("%s.html は次回対応と査定の申込のお知らせを説明している", (_name, src) => {
    expect(src()).toContain("新しい査定の申込が◯件あります");
    expect(src()).toContain("自分の次回対応（今日・期限切れ）");
  });

  // @codex R1: 再通知は期限から1週間で止まる(reminder-schedule.ts REMINDER_STOP_MS)・
  // 謄本の一括取得の完了も知らせる(summary-state.ts registry_job_done)。
  it.each([
    ["guide", () => guideSrc],
    ["manual", () => manualSrc],
  ])("%s.html は次回対応の再通知が1週間で止まることと、一括取得の完了の知らせを書いている", (_name, src) => {
    expect(src()).toContain("期限から1週間たつと出なくなります");
    expect(src()).toContain("謄本の一括取得が完了しました");
  });

  // @codex R2: ベルの知らせを列挙する行(用語・稼働中)ごとに、6種類の知らせが揃っているかを見る。
  const lineWith = (src: string, marker: string) => {
    const lines = src.split("\n").filter((l) => l.includes(marker));
    expect(lines).toHaveLength(1);
    return lines[0];
  };
  it.each([
    ["guide 用語", () => lineWith(guideSrc, "<tr><td>お知らせ（ベル）</td>")],
    ["guide 稼働中", () => lineWith(guideSrc, "<li><b>お知らせ（ベル）と通知</b>")],
    ["manual 用語", () => lineWith(manualSrc, "<tr><td>お知らせ（ベル）</td>")],
  ])("%s の行はベルの知らせを全部挙げている", (_name, line) => {
    const row = line();
    for (const word of ["自動ログオフ", "編集権限", "次回対応", "査定の申込", "謄本の一括取得の完了"]) {
      expect(row).toContain(word);
    }
  });

  // @codex R3: 右下の知らせは画面を見ているときだけ(summary-poller.tsx show())。
  it("guide.html は「右下に出る」を画面を見ているときに限っている", () => {
    expect(guideSrc).not.toContain("と、ベルと画面の右下に出ます");
    expect(guideSrc).toContain("画面に戻っても右下には出ません");
  });

  it("manual.html は別のタブを見ている間の分は右下に出ないと書いている", () => {
    expect(manualSrc).toContain("右下には出ず 🔔 に残ります");
  });

  // @codex R4: 自動ログオフの予告(小窓)・編集権限(帯/戻ったときの右下)は別の出方なので、
  // 右下の説明は下の3つ(件数の知らせ)に限る。
  it("manual.html の右下の説明は件数の知らせ3つに限っている", () => {
    const line = manualSrc.split("\n").find((l) => l.includes("いまお知らせに出るのは次の6つです。")) ?? "";
    expect(line).toContain("<b>下の3つ</b>（次回対応・査定の申込・謄本の一括取得の完了）");
    expect(line).not.toContain("6つです。このシステムの画面を見ているときは画面の右下にも出ます");
  });

  it("manual.html のお知らせの表は6つ", () => {
    expect(manualSrc).toContain("いまお知らせに出るのは次の6つです。");
  });

  it("guide.html は次回対応・査定の申込のお知らせを「これから」に置いていない", () => {
    expect(guideSrc).not.toContain("次回対応（当日・期限切れ）、新しい査定の申込、謄本の一括取得の完了をベルでお知らせする段");
    expect(guideSrc).not.toContain("次回対応・査定の申込・謄本の一括取得の完了のお知らせと、画面を閉じていても届く通知は、これから作ります");
  });
});
