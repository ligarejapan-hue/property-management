import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const dialog = readFileSync(
  path.join(process.cwd(), "src/components/admin/inquiry-notify-dialog.tsx"),
  "utf8",
);
const page = readFileSync(
  path.join(process.cwd(), "src/app/(dashboard)/admin/users/page.tsx"),
  "utf8",
);

describe("利用者ごとの通知設定ダイアログ", () => {
  it("手書きモーダルではなく ModalShell を使う", () => {
    expect(dialog).toContain('from "@/components/ui/modal-shell"');
    expect(dialog).toMatch(/<ModalShell/);
    expect(dialog).not.toMatch(/fixed inset-0/);
  });

  it("売却DMを使えない利用者への警告文言", () => {
    expect(dialog).toContain(
      "売却DMを使える権限がないため、この人には通知が届きません",
    );
    expect(dialog).toContain("canUseSaleDm");
  });

  it("メール欄の placeholder はログイン email(loginEmail)", () => {
    expect(dialog).toMatch(/placeholder=\{loginEmail\}/);
  });

  it("受け取る/受け取らないのチェックボックス文言", () => {
    expect(dialog).toContain("査定申込の通知メールを受け取る");
  });

  it("bg-blue-600 / border-b-2 の手書きを増やさない", () => {
    expect(dialog).not.toContain("bg-blue-600");
    expect(dialog).not.toContain("border-b-2");
  });

  it("api-client の2関数を使う", () => {
    expect(dialog).toContain("getUserInquiryNotify");
    expect(dialog).toContain("updateUserInquiryNotify");
  });
});

describe("読み込み失敗時は保存を止める(review fix: 無言での通知OFF/宛先クリア防止)", () => {
  it("保存ボタンは loaded=false のとき disabled", () => {
    expect(dialog).toMatch(/disabled=\{saving \|\| loading \|\| !loaded\}/);
  });
  it("読み込み失敗の案内文言と再読み込み導線がある", () => {
    expect(dialog).toContain("設定を読み込めませんでした。再読み込みしてください。");
    expect(dialog).toContain("再読み込み");
    expect(dialog).toMatch(/onClick=\{load\}/);
  });
  it("loaded は読み込み成功時だけ true になる(失敗時は false のまま)", () => {
    const start = dialog.indexOf("const load = ");
    const end = dialog.indexOf("}, [userId]);", start);
    const fn = dialog.slice(start, end);
    const catchIdx = fn.indexOf("} catch");
    const trueIdx = fn.indexOf("setLoaded(true)");
    const falseIdx = fn.indexOf("setLoaded(false)");
    expect(trueIdx).toBeGreaterThan(-1);
    expect(trueIdx).toBeLessThan(catchIdx);
    expect(falseIdx).toBeGreaterThan(catchIdx);
  });
});

describe("ユーザー一覧: 通知ボタン", () => {
  it("権限リンクの隣に type=button の通知ボタンがある", () => {
    const shieldIdx = page.indexOf("権限");
    const notifyIdx = page.indexOf("通知", shieldIdx);
    expect(shieldIdx).toBeGreaterThan(-1);
    expect(notifyIdx).toBeGreaterThan(shieldIdx);
    const between = page.slice(shieldIdx, notifyIdx);
    // 権限リンクと通知ボタンの間に他の操作ボタン(削除・無効化等)が挟まらない=隣接。
    expect(between).not.toContain("削除");
    expect(between).not.toContain("無効化");
  });

  it("通知ボタンは type=\"button\"(フォーム誤submit防止)", () => {
    const notifyBtnStart = page.indexOf("setNotifyUser(u)");
    expect(notifyBtnStart).toBeGreaterThan(-1);
    const buttonTagStart = page.lastIndexOf("<button", notifyBtnStart);
    const snippet = page.slice(buttonTagStart, notifyBtnStart);
    expect(snippet).toContain('type="button"');
  });

  it("InquiryNotifyDialog を組み込んでいる", () => {
    expect(page).toContain('from "@/components/admin/inquiry-notify-dialog"');
    expect(page).toMatch(/<InquiryNotifyDialog/);
  });
});
